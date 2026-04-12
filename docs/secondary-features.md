# Secondary Features Deep Dive

Features that are important but less regression-prone than the core pipeline. Each section covers the code flow, state dependencies, and gotchas.

---

## 1. Session Scribe

**Source:** `src/ai/scribe.js`

**Trigger:** Counter-based in `CHARACTER_MESSAGE_RENDERED` handler (`index.js` L1349-1356). Fires when `chat.length - lastScribeChatLength >= settings.scribeInterval` and `!scribeInProgress`.

**Flow:**
```
CHARACTER_MESSAGE_RENDERED
  → Check: chat.length - lastScribeChatLength >= scribeInterval
  → Check: !scribeInProgress
  → runScribe()  (fire-and-forget)
    → setScribeInProgress(true)
    → Build context from recent chat messages
    → Include lastScribeSummary as prior context
    → callAI(scribePrompt, context, resolveConnectionConfig('scribe'))
    → writeNote(vaultName, filename, responseText)  (Obsidian REST API)
    → buildIndex()  (re-index to pick up new note)
    → setLastScribeChatLength(chat.length)
    → setLastScribeSummary(responseText)
    → Persist both to chat_metadata
    → setScribeInProgress(false)  (in finally)
```

**State:**
- `scribeInProgress`: Lock. **NOT reset on CHAT_CHANGED** (BUG-275). The in-flight scribe owns its flag and releases it in its own `finally`. Resetting in CHAT_CHANGED would let concurrent scribes race.
- `lastScribeChatLength`: Hydrated from `chat_metadata.deeplore_lastScribeChatLength` on CHAT_CHANGED. Falls back to `chat.length` on first visit.
- `lastScribeSummary`: Hydrated from `chat_metadata.deeplore_lastScribeSummary`. Fed into the next scribe call as context.

**Scribe-informed retrieval:** `lastScribeSummary` is available to the AI search manifest builder, providing session context to improve lore selection even when explicit keywords are sparse.

**Connection:** `resolveConnectionConfig('scribe')` — independent connection config, can inherit from aiSearch.

---

## 2. AI Notebook

**Source:** `index.js` L1112-1187 (GENERATION_ENDED handler), L1324-1345 (CHARACTER_MESSAGE_RENDERED fallback)

Two modes: `tag` and `extract`.

### Tag Mode (default)
The AI writes `<dle-notes>` blocks in its response. DLE extracts them post-generation.

**Flow (GENERATION_ENDED):**
```
→ Capture tagEpoch = chatEpoch
→ extractAiNotes(lastMessage.mes) → { notes, cleanedMessage }
→ If notes && tagEpoch === chatEpoch:
    → lastMessage.mes = cleanedMessage  (strip tags from visible text)
    → lastMessage.extra.deeplore_ai_notes = notes
    → chat_metadata.deeplore_ai_notepad = capNotepad(existing + notes)
    → saveMetadataDebounced()
```

**Injection (onGenerate L644-668):** Injects previous notes as `[Your previous session notes]` block + instruction prompt (DEFAULT_AI_NOTEPAD_PROMPT) at configured position/depth/role.

### Extract Mode
DLE strips visible note-taking prose, then fires an async API call to extract session notes.

**Flow (GENERATION_ENDED):**
```
→ Strip VISIBLE_NOTES_PATTERNS from lastMessage.mes
→ Check: !notepadExtractInProgress
→ Capture extractEpoch = chatEpoch, swipeIdAtStart
→ Async:
    → setNotepadExtractInProgress(true)
    → callAI(extractPrompt, context, resolveConnectionConfig('aiNotepad'))
    → POST-AWAIT: check extractEpoch === chatEpoch
    → POST-AWAIT: check message.swipe_id === swipeIdAtStart (BUG-AUDIT-CNEW01)
    → If response !== 'NOTHING_TO_NOTE':
        → message.extra.deeplore_ai_notes = response
        → chat_metadata.deeplore_ai_notepad = capNotepad(existing + response)
    → finally: setNotepadExtractInProgress(false)
```

### Fallback (CHARACTER_MESSAGE_RENDERED)
Tag-mode extraction also runs here (L1324-1345) to catch notes missed by GENERATION_ENDED (e.g., swipe back to a response that has unextracted `<dle-notes>`).

### Storage
- **Per-message:** `message.extra.deeplore_ai_notes` — the extracted notes for this specific message
- **Accumulated:** `chat_metadata.deeplore_ai_notepad` — all notes concatenated, capped at 64KB (`AI_NOTEPAD_MAX_CHARS`)
- **Cap function:** `capNotepad(text)` — trims oldest block at paragraph boundary (`\n\n`)

### Swipe Rollback (BUG-290)
On `MESSAGE_SWIPED` (L1402-1419): Removes the **last occurrence** of the swiped message's notes from `deeplore_ai_notepad`, anchored on `'\n' + notes`. Uses `lastIndexOf` (not first `replace`) to avoid removing an earlier message's identical notes.

Same rollback pattern in `MESSAGE_DELETED`, `MESSAGE_SWIPE_DELETED`, and `MESSAGE_EDITED` handlers.

---

## 3. Author's Notebook

**Source:** `index.js` L629-639

Simple user-written per-chat notes. Stored in `chat_metadata.deeplore_notebook`.

Injected as auxiliary prompt via `_injectAuxPrompt('deeplore_notebook', content, position, depth, role)` during onGenerate commit phase. No AI involvement — purely user content.

---

## 4. Auto-Suggest (Auto Lorebook)

**Source:** `src/ai/auto-suggest.js`

**Trigger:** Counter in `CHARACTER_MESSAGE_RENDERED` handler (L1359-1372). Increments `autoSuggestMessageCount` each render. When count reaches `settings.autoSuggestInterval`, resets counter and fires `runAutoSuggest()`.

**Flow:**
```
→ runAutoSuggest()
    → Build context from recent chat
    → callAI(suggestPrompt, context, resolveConnectionConfig('autoSuggest'))
    → Parse response into entry suggestions
    → Return suggestions array
→ showSuggestionPopup(suggestions)
    → Modal with suggested entries for user review
```

**State:** `autoSuggestMessageCount` — reset to 0 on CHAT_CHANGED.

---

## 5. Context Cartographer

**Source:** `src/ui/cartographer.js`, `index.js` L1069-1082 (delegation), L1307-1321 (render handler)

Shows a "Sources" button on messages that had lore injected.

### Source Tagging (onGenerate L591-600)
```
setLastInjectionSources(injectedEntries.map(e => ({
    title, filename, matchedBy, priority, tokens, vaultSource
})))
setLastInjectionEpoch(epoch)
```

### Source Consumption (CHARACTER_MESSAGE_RENDERED L1307-1321)
```
→ Check: lastInjectionSources exists and is non-empty
→ Check: lastInjectionEpoch === chatEpoch (epoch guard)
→ Check: not already consumed for this messageId (_consumedByMesId)
→ Store on message.extra.deeplore_sources
→ saveMetadataDebounced()
→ injectSourcesButton(messageId)
```

### Click Delegation (L1069-1082)
Namespaced as `.dle-carto` on `#chat` for clean teardown. Handles `click` and `keydown` (Enter/Space for a11y). Opens `showSourcesPopup(sources, { aiNotes })`.

### Diff Display
`previousSources` (in state.js) holds the prior generation's sources for side-by-side comparison in the popup.

**Gotcha:** `lastPipelineTrace` doubles as a fallback display source when `lastInjectionSources` is cleared after render — don't blindly null it.

---

## 6. Relationship Graph

**Source:** `src/graph/graph.js` (orchestrator), `graph-physics.js`, `graph-render.js`, `graph-events.js`, `graph-focus.js`, `graph-analysis.js`, `graph-settings.js`

Custom Canvas-based force-directed graph visualization (no external library).

**Data source:** `mentionWeights` (cross-entry content mentions used for edge weight) + `resolvedLinks` + `requires` + `excludes` + `cascadeLinks` from vault entries. Four edge types: `link`, `requires`, `excludes`, `cascade`.

**Node colors:** Default mode is type-based (constant = orange `#ff9800`, seed = blue, bootstrap = purple, regular = green). Also supports priority, centrality, frequency, community, and custom-field color modes.

**Physics:** ForceAtlas2-like repulsion model with configurable parameters.

**Focus mode:** Highlights path from selected node through connected nodes. Depth-limited by `graphHoverFalloff` (transmission per hop — `E[d] = t^d`).

**Exit key:** `e` (NOT Escape). Escape bubbles to ST popup which would close the graph modal. See `reference_dialog_escape.md` in memory.

**`graph: false` frontmatter field:** Excludes entry from graph entirely.

**Gotcha:** Graph feature is complete for v0.2.0 — do not suggest refactors (see `project_graph_complete.md` in memory).

---

## 7. Diagnostics

**Source:** `src/diagnostics/`

### boot.js
First import in `index.js` (L7). Installs console/fetch/XHR/error interceptors and starts PerformanceObserver (long-task tracking) at **module-eval time** so DLE captures cold-start bugs in itself and other extensions. This runs before any other DLE code.

### flight-recorder.js
Ring buffer of per-generation event summaries. Started in init (L882-887). Records pipeline runs, AI calls, errors, aborts. Used by `/dle-diagnostics` export.

**`recordAbort(msg)`** — called from onGenerate catch block (L807) on user abort.

### state-snapshot.js
`captureStateSnapshot()` — Returns sanitized copy of all state variables for diagnostic export. Removes sensitive data (API keys) via `scrubber.js`.

### performance.js
`startPerformanceObservers()` — installs a `PerformanceObserver` for long tasks (>50ms) into a ring buffer (`longTaskBuffer`). Called from `boot.js` at module-eval time. `captureMemorySnapshot()` — one-shot snapshot of `performance.memory` + navigation timing, included in diagnostic exports.

### interceptors.js / ring-buffer.js
Support infrastructure for the diagnostics system. Console interceptor monkey-patches all five levels (`log`, `warn`, `error`, `debug`, `info`) from all extensions (not just DLE) into `consoleBuffer`. Network interceptor patches `fetch` and `XHR` into `networkBuffer`. Error interceptor captures `window.onerror` and `unhandledrejection` into `errorBuffer`. Ring buffer (`RingBuffer`) keeps last N entries per buffer (fixed-size, oldest evicted on overflow).

### scrubber.js
`scrubDeep(value)` — Recursively walks a value and returns a scrubbed deep copy. Masks API keys (field-name matching via `SENSITIVE_KEY_RE`), auth tokens, IPs, emails, hostnames, user paths, and high-entropy token strings. Cardinality-preserving pseudonyms (same real value → same alias within one export). `scrubString(str, ctx)` handles individual string scrubbing.

### ui.js
User-facing entry point: `triggerDiagnosticDownload()` builds the anonymized report + unanonymized reference file and triggers browser download via ephemeral `<a>` element.

### export.js
`buildDiagnosticReport()` — Assembles the full diagnostic markdown report. Captures state snapshot, drains all ring buffers (console, network, error, generation, long-task), runs `scrubDeep()`, compresses via gzip, and encodes as base64 data block.
