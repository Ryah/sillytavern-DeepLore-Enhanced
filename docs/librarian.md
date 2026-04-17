# Librarian Subsystem Internals

Code-level reference for the Librarian tool-calling subsystem. Intended for Claude Code
to avoid regressions when modifying Librarian-related code.

Source files:
- `src/librarian/agentic-api.js` -- provider detection, CMRS wrapper + proxy path (`callWithTools`), response parsing (4 formats)
- `src/librarian/agentic-loop.js` -- state machine: SEARCH -> FLAG -> DONE
- `src/librarian/agentic-messages.js` -- system prompt builder, chat message assembly
- `src/librarian/librarian-tools.js` -- `searchLoreAction`, `flagLoreAction`, gap persistence
- `src/librarian/librarian-ui.js` -- per-message dropdown injection
- `src/librarian/librarian-session.js` -- Emma conversation engine, session persistence
- `src/librarian/librarian-chat-tools.js` -- tools available inside Emma's conversation loop
- `src/librarian/librarian-prompts.js` -- bootstrap system prompts for guide-mode sessions
- `src/librarian/librarian-review.js` -- two-panel popup UI (editor + chat)
- `src/librarian/visibility.js` -- show/hide all Librarian surfaces
- `index.js` -- agentic loop dispatch in `onGenerate`, event handlers: `MESSAGE_SWIPED`, `CHAT_CHANGED`
- `src/state.js` -- state variables (including `setGenerationLockTimestamp` for keepalive)

---

## 1. Agentic Loop Architecture

DLE owns the entire tool-calling loop. No ST ToolManager, no intermediate system messages, no splicing.

### Dispatch (index.js, after pipeline commit)

After the pipeline commits lore via `setExtensionPrompt` and `_updatePipelineStatus('Generating...')`:

1. Guard: `settings.librarianEnabled && isToolCallingSupported()`
2. `abort()` — prevents ST from generating (the interceptor's abort callback)
3. `setSendButtonState(true)` + `deactivateSendButtons()` — C1: re-entrancy guard (abort re-enables send via `unblockGeneration`)
4. Build messages: `buildChatMessages(chatMessages, pipelineContext, injectedTitles, settings)` — 9-section system prompt + chat history
5. `runAgenticLoop(options)` — core state machine (onProse callback → `saveReply` during loop)
6. On success: `saveReply` handles `chat.push`, `addOneMessage`, disk save. Post-loop: emit `MESSAGE_RECEIVED` + `CHARACTER_MESSAGE_RENDERED`
7. Finally: `setSendButtonState(false)` + `activateSendButtons()`, emit `GENERATION_ENDED`, return (don't fall through to ST generation)

If `isToolCallingSupported()` is false, falls through to ST's normal generation path. A `dedupWarning` fires at runtime when `librarianEnabled && !isToolCallingSupported()` to warn the user that function calling is required.

### State Machine (agentic-loop.js)

```
SEARCH phase:
  Available tools: search + write (search capped by maxSearches)
  write() call → captures prose → transitions to FLAG phase

FLAG phase:
  Available tools: flag (capped at MAX_FLAG_CALLS = 5)
  AI ends turn (no tool calls) → DONE

DONE:
  Return { prose, toolActivity, usage }
```

Constants: `MAX_ITERATIONS = 15`, `MAX_FLAG_CALLS = 5`.

### Tool Definitions (agentic-loop.js)

Three tools in OpenAI function calling format:

| Tool | Phase | Purpose |
|---|---|---|
| `search` | SEARCH | BM25 vault search (delegates to `searchLoreAction`) |
| `write` | SEARCH | Submit final prose response — triggers SEARCH->FLAG transition |
| `flag` | FLAG | Flag lore gaps/updates (delegates to `flagLoreAction`) |

`write` is always available in SEARCH phase. When it is the only tool left (search limit reached), the system prompt instructs the AI to call it — no `toolChoice` forcing needed (see H1 comment, `agentic-loop.js` L152-154: always `'auto'`).

### Provider Format Handling (agentic-api.js)

`callWithTools()` dispatches based on the Librarian's resolved connection mode (`resolveConnectionConfig('librarian')`):
- **Proxy mode** (`mode === 'proxy'`): calls `callWithToolsViaProxy()` which sends directly to an Anthropic-compatible proxy (e.g. claude-code-proxy) via ST's CORS bridge. Tools are converted from OpenAI to Anthropic format (`toAnthropicTools`). Messages with `role: 'system'` are extracted into the `system` field. Response is raw Anthropic JSON — existing parsers handle it natively.
- **Profile mode** (default): wraps `ConnectionManagerRequestService.sendRequest()` using the active connection profile (`getActiveProfileId()`).

`isToolCallingSupported()` returns `true` in proxy mode (Anthropic API always supports tools). `getProviderFormat()` returns `'claude'` in proxy mode. `getActiveMaxTokens()` uses the Librarian's configured `maxTokens` in proxy mode.

Four provider response formats are handled:

| Provider | Detection | Tool call location | Text location |
|---|---|---|---|
| Claude | `chat_completion_source === 'claude'` | `data.content[].type === 'tool_use'` | `data.content[].type === 'text'` |
| Google (Gemini/Vertex) | `makersuite` or `vertexai` | `data.responseContent.parts[].functionCall` | `data.responseContent.parts[].text` |
| OpenAI-compatible | default | `data.choices[0].message.tool_calls` | `data.choices[0].message.content` |
| Cohere | (via OpenAI path) | `data.message.tool_calls` | `data.message.content[0].text` |

`isToolCallingSupported()` returns false for `main_api !== 'openai'` or sources in `NO_TOOLS_SOURCES` (ai21, perplexity, nanogpt, pollinations, moonshot).

Google Gemini `tool_choice` normalization (G6): string values mapped to `{ mode: 'AUTO'|'ANY'|'NONE' }`.

### Message Assembly (agentic-messages.js)

`buildChatMessages()` produces a `[{role, content}]` array:

1. System message: 9-section prompt (role, character context, pipeline lore, injected title list, notebook, notepad, scribe summary, tool instructions, custom prompt)
2. Chat history: last 40 non-system messages from `chat[]`, strict role alternation enforced, last message must be `user`

`buildToolResults()` handles provider-native format (C4): Claude requires all `tool_result` blocks in ONE user message; Google uses `functionResponse` parts; OpenAI/Cohere use separate `tool` role messages.

### Key Guards

- **Epoch guards:** Checked at top of every iteration: `epoch !== chatEpoch || lockEpoch !== generationLockEpoch` → break
- **Abort signal:** Checked at top of every iteration → throws `AbortError`
- **C9 keepalive:** `setGenerationLockTimestamp(Date.now())` before every API call and before tool processing, preventing the 30s stale-lock detector from force-releasing mid-loop
- **C1 re-entrancy:** `setSendButtonState(true)` after `abort()` (which calls `unblockGeneration`), restored in finally
- **H4 double-write guard:** `writeDone` flag prevents multiple `write()` calls

### Logging

- **`agentic-loop.js`:** `pushEvent` fires on loop start and completion (with `exitReason` and iteration counter). An always-on summary log line is emitted on completion regardless of debug mode.
- **`librarian-tools.js`:** `searchLoreAction` and `flagLoreAction` have debug-gated logging for query counts, BM25 hit counts, and epoch guard checks.
- **`librarian-chat-tools.js`:** `executeToolCall` is wrapped with per-call timing. `toolFlagEntryUpdate` has always-on logging (not debug-gated) since flag writes are infrequent and diagnostically important.

---

## 2. Search Action

**File:** `src/librarian/librarian-tools.js`, L355-542

### `searchLoreAction(args) -> Promise<string>`

**Input shape:**
```js
{ queries: string[] }   // preferred
{ query: string }        // legacy fallback -- coerced to [query]
```
Queries are trimmed, filtered, capped to 4 (L371).

**Flow:**

1. Guard: `loreGapSearchCount >= settings.librarianMaxSearches` returns limit message.
2. Increment `loreGapSearchCount` IMMEDIATELY (L381) -- before any await -- to prevent race when AI sends multiple concurrent search_lore calls.
3. Await `buildPromise` if vault index still loading.
4. BM25 search via `queryBM25(fuzzySearchIndex, query, librarianMaxResults, fuzzySearchMinScore)`.
5. Filter out already-injected titles (`lastInjectionSources`) and `guide` entries (L443).
6. Select single best hit (highest BM25 score across all queries), return full content.
7. Resolve up to 3 linked entries from best hit's `resolvedLinks` -- manifest/summary format only.
8. Report other match counts across remaining queries.

**Return format:** Markdown sections separated by `---`. Best hit gets full `### Title\n{content}`, linked entries get XML `<entry>` manifest, no-result queries get plain text.

**Side effects:**

| Side effect | Target | Condition |
|---|---|---|
| Gap record creation | `loreGaps` via `persistGaps()` | No-result queries only |
| Gap record removal | `loreGaps` via `persistGaps()` | Query now has results but had a prior gap |
| `sessionActivityLog.push(logEntry)` | Module-local array | Always |
| Analytics | `settings.analyticsData._librarian.totalGapSearches` | Always |
| Stats | `librarianSessionStats`, `librarianChatStats` | Always |

**Log entry shape:**
```js
{ type: 'search', query: string, resultCount: number, resultTitles: string[],
  tokens: number, timestamp: number, generation: number }
```

### Token estimation (BUG-AUDIT-H19)

Uses accumulated `totalTokens` from real `entry.tokenEstimate` values. Falls back to `resultText.length / 4` only if `totalTokens` is 0 (L513).

---

## 3. Flag Action

**File:** `src/librarian/librarian-tools.js`, L549-634

### `flagLoreAction(args) -> Promise<string>`

**Input shape:**
```js
{ title: string, reason: string, urgency?: 'low'|'medium'|'high',
  flag_type?: 'gap'|'update', entry_title?: string }
```

**Flow:**

1. Validate `title` and `reason` are non-empty.
2. Default `urgency` to `'medium'`, `flag_type` to `'gap'`.
3. Call `findSimilarGap(loreGaps, title, 'flag', flagType)` for overlap detection.
4. If overlapping gap found: merge (increment frequency, escalate urgency if higher, append reason). Also `clearHiddenSilently()` to resurface hidden gaps.
5. If new: create gap record with `gapId()`, `type: 'flag'`, `subtype: flagType`.
6. Persist via `persistGaps(updatedGaps)` (guarded by `epoch === chatEpoch`).

**Gap record shape (flag):**
```js
{ id, type: 'flag', subtype: 'gap'|'update', entryTitle, query: title,
  reason, createdAt, timestamp, generation, status: 'pending',
  frequency: 1, urgency, hadResults: false, resultTitles: null }
```

**Side effects:** Same pattern as searchLoreAction -- pushes to `sessionActivityLog` with epoch guards. Tokens estimated at 10 (minimal overhead).

**Return text:** Includes instructions to not acknowledge the flag and continue.

### Overlap detection: `findSimilarGap()`

**File:** `src/librarian/librarian-tools.js`, L81-101

Tokenizes both queries via `tokenize()` (from BM25 module), computes Jaccard-like overlap ratio: `overlap / max(newSet.size, existingSet.size)`. Threshold: **>0.6** (60%). Only compares gaps with matching `type` and optionally `subtype`.

**Gotcha:** Uses `>` not `>=`, so exactly 60% overlap does NOT merge.

---

## 4. Tool Call Persistence

Tool call data (search and flag activity records) is stored on `message.extra.deeplore_tool_calls` (per-message), NOT in `chat_metadata`. This is different from `deeplore_lore_gaps` which is in `chat_metadata`.

In the agentic loop, tool activity is returned as `result.toolActivity` and stored directly on the message object during construction in `onGenerate`. No intermediate buffer or GENERATION_ENDED consolidation needed -- the loop completes before the message is created.

---

## 6. Librarian Session

**File:** `src/librarian/librarian-session.js`

### Session persistence

**Moved from localStorage to `chat_metadata`** (BUG-043). Key: `deeplore_librarian_session`.

| Function | Purpose |
|---|---|
| `saveSessionState(session)` | Serializes to `chat_metadata[SESSION_METADATA_KEY]`, calls `saveMetadataDebounced()` |
| `loadSessionState()` | Reads from `chat_metadata`, falls back to legacy `localStorage` key (one-time migration) |
| `clearSessionState()` | Deletes from both `chat_metadata` and `localStorage` |
| `restoreSession(saved)` | Rebuilds `LibrarianSession` object from persisted data |

**Persisted fields:** `messages`, `draftState`, `entryPoint`, `gapRecord`, `manifest`, `chatContext`, `relatedEntries`, `workQueue`, `lastOptions` (BUG-326), `mode`, `guideBootstrap`, `savedAt`.

### Clear triggers

| Event | Handler | Effect |
|---|---|---|
| `CHAT_DELETED` | `clearLibrarianSessionState()` | Clears session from chat_metadata + localStorage |
| `GROUP_CHAT_DELETED` | `clearLibrarianSessionState()` | Same |
| `CHAT_CHANGED` | (index.js L1696) | `clearSessionActivityLog()` (session state itself is per-chat, so it persists within the chat) |

### Session creation: `createSession(entryPoint, options)`

Entry points: `'gap'`, `'new'`, `'review'`, `'audit'`.
Modes (via `options.mode`): `'guide-firstrun'`, `'guide-adhoc'`, or `null`.

Builds: `manifest` (from `buildCandidateManifest(vaultIndex)`), `chatContext` (from `buildAiChatContext(chat, scanDepth)`), `relatedEntries` (BM25 search for gap queries).

Guide modes prepend `buildLibrarianBootstrapSystemPrompt()` (from librarian-prompts.js) and seed a greeting message.

### Agentic loop: `sendMessage(session, userMessage, options)`

Outer loop (tool_call -> re-enter AI) with inner loop (validation retries).

**Caps:**
- `MAX_VALIDATION_RETRIES = 3`
- `MAX_TOOL_CALLS_PER_TURN = 10`
- `MAX_AGENTIC_ITERATIONS = 15` (BUG-232)
- `MAX_HISTORY_MESSAGES = 10`

**Epoch guards (BUG-273):** Snapshots `chatEpoch` at entry. Re-checks after every `await callAI()` (both success and error paths) and at top of each loop iteration. On mismatch, restores history from snapshot and returns.

**Abort handling (BUG-237/253/303):** Snapshots `session.messages` before mutation. On abort or epoch mismatch, restores the snapshot so the session is not left with a one-sided user turn or orphan tool_results.

**Tool execution:** Calls `executeToolCall(name, args, session)` from `librarian-chat-tools.js`. These are Emma's internal tools (search_vault, get_entry, etc.), distinct from the agentic loop's tools (search, write, flag).

---

## 7. Librarian Chat Tools

**File:** `src/librarian/librarian-chat-tools.js`

These tools are available ONLY inside Emma's conversation loop (`sendMessage`). They are NOT the agentic loop's tools — they are executed locally via `executeToolCall()`.

### Tool list

| Tool | Read/Write | Notes |
|---|---|---|
| `search_vault` | Read | BM25 search, top_k up to 20, min score 0.3 |
| `get_entry` | Read | Truncated preview (~2000 chars), metadata |
| `get_full_content` | Read + side effect | Full content (cap 16000 chars). Populates `session.draftState` automatically |
| `find_similar` | Read | Duplicate detection before creating new entries |
| `list_flags` | Read | Lists `loreGaps` records |
| `get_links` | Read | Outgoing `resolvedLinks` from an entry |
| `get_backlinks` | Read | All entries whose `resolvedLinks` include the target |
| `list_entries` | Read | Filter by type and/or tag |
| `get_recent_chat` | Read | Last N messages from `getContext().chat` (max 50) |
| `flag_entry_update` | **Write** | Creates a gap record in `loreGaps`/`chat_metadata` |
| `compare_entry_to_chat` | Read | Side-by-side entry + recent chat (cap 6000 chars) |
| `get_writing_guide` | Read | Dynamic -- only available when `lorebook-guide` entries exist in vault |

### `get_writing_guide` tool

**File:** `src/librarian/librarian-chat-tools.js`, L480-495

Serves entries tagged `lorebook-guide` (entries where `entry.guide === true`). Uses kebab-case title matching. These entries are **never injected into the writing AI** through the normal pipeline -- they exist exclusively for the Librarian.

**Gotcha (BUG-325):** `get_writing_guide` is not in the static `LIBRARIAN_TOOLS` array -- it is dynamically built in `buildToolsPromptSection()` (L505-558) only when guide entries exist. The `default` case in `executeToolCall()` must list it explicitly in the error message (L162-167).

### `buildToolsPromptSection()`

Generates the tools documentation section embedded in Emma's system prompt. Rebuilt every turn so the `get_writing_guide` enum reflects the current vault state.

---

## 8. Per-Message Activity Mode

**Setting:** `librarianPerMessageActivity` (default: `false`).

### Behavior differences

| Behavior | OFF (default) | ON |
|---|---|---|
| Gap records on gen start | Kept (accumulate) | Cleared via `persistGaps([])` (index.js L283-285) |
| Gap records on swipe | N/A (already accumulated) | Kept (not cleared) |
| `deeplore_tool_calls` on swipe | Deleted from `message.extra` (index.js L1391-1394) | Preserved (will be replaced on next gen) |
| Dropdown DOM on swipe | Removed | Removed (DOM always cleared; data preserved for re-render) |
| Dropdown data persistence | Ephemeral (deleted on swipe) | Per-message (survives swipe) |

### Implementation details

**Gap clearing (index.js L283-285):**
```js
if (settings.librarianPerMessageActivity && settings.librarianEnabled) {
    persistGaps([]);
}
```
Runs inside `onGenerate()` after lock acquisition, before the pipeline runs.

**Swipe handling (index.js L1388-1400):**
```js
if (!getSettings().librarianPerMessageActivity) {
    if (message.extra?.deeplore_tool_calls) {
        delete message.extra.deeplore_tool_calls;
        saveMetadataDebounced();
    }
}
removeLibrarianDropdown(messageId);  // always
```

**CHAT_CHANGED hydration (index.js L1689-1697):**
Regardless of this setting, `CHAT_CHANGED` always hydrates `loreGaps` from `chat_metadata.deeplore_lore_gaps` (normalizing legacy statuses), resets `loreGapSearchCount`, resets `librarianChatStats`, and clears `sessionActivityLog`.

**Dropdown re-render on chat load (index.js L1830-1833):**
After migration, if `librarianEnabled && librarianShowToolCalls`, iterates all messages and calls `injectLibrarianDropdown(i, chat[i].extra.deeplore_tool_calls)` for any message that has stored tool call data.

---

## Cross-Cutting Concerns

### Gap persistence: `persistGaps(updatedGaps)`

**File:** `src/librarian/librarian-tools.js`, L108-139

1. Checks `getContext().chatMetadata` availability BEFORE mutating state (BUG-304).
2. Caps gap count to 200 (BUG-AUDIT-C03), evicting oldest by `createdAt`.
3. Sets `loreGaps` in state, writes `meta.deeplore_lore_gaps`.
4. Prunes orphaned IDs from `deeplore_lore_gaps_hidden` and `deeplore_lore_gaps_dismissed` sibling arrays (BUG-AUDIT-H09).
5. `saveMetadataDebounced()`.

### Gap soft-removal (two tiers)

| Tier | Array | Re-flag behavior |
|---|---|---|
| Hidden | `deeplore_lore_gaps_hidden` | Re-flag resurfaces (calls `clearHiddenSilently`) |
| Dismissed | `deeplore_lore_gaps_dismissed` | Re-flag does NOT resurface, but escalates urgency silently |

Functions: `hideGap()`, `unhideGap()`, `dismissGap()`, `undismissGap()`.

### `notifyLoreGapsChanged()`

**File:** `src/state.js`, L527-541

Callback-based observer pattern. `setLoreGaps()` calls it automatically. Also called explicitly by `searchLoreAction` and `flagLoreAction` after pushing to `sessionActivityLog` (to update the Activity sub-tab even when `persistGaps` was not called).

### Session stats vs chat stats

| Variable | Scope | Reset trigger |
|---|---|---|
| `librarianSessionStats` | Page load | Never (survives CHAT_CHANGED) |
| `librarianChatStats` | Per-chat | `CHAT_CHANGED` (index.js L1695) |

Both track `{ searchCalls, flagCalls, estimatedExtraTokens }`.

### Connection Mode Default and Migration

**`librarianConnectionMode` now defaults to `'inherit'`** (was `'profile'`). The `inherit` mode falls back to `aiSearch` connection settings.

**Migration v2→v3** (`settingsVersion` bumped from 2 to 3): Unconfigured profile connections are auto-migrated to `inherit`. This runs in `getSettings()` when `settingsVersion < 3`.

**Onboarding validation**: When the Librarian is enabled in settings, validation checks the connection config and shows a toastr warning if function calling is not supported by the current provider/model.

**Runtime warning**: `dedupWarning` fires in `onGenerate` when `librarianEnabled && !isToolCallingSupported()`. This catches cases where the user enables the Librarian but their active connection doesn't support tool calling.

---

### Activity feed: `buildLibrarianActivityFeed()`

**File:** `src/librarian/librarian-tools.js`, L210-255

Merges session activity log (in-memory) with persistent gap records (loreGaps). Deduplicates by `type:query:timestamp/2000` key. Persistent search gaps are excluded (only live session searches shown). Returns newest-first array consumed by both the drawer and the popup.
