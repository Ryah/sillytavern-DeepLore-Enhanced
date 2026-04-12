# Librarian Subsystem Internals

Code-level reference for the Librarian tool-calling subsystem. Intended for Claude Code
to avoid regressions when modifying Librarian-related code.

Source files:
- `src/librarian/librarian.js` -- tool registration + lifecycle
- `src/librarian/librarian-tools.js` -- `searchLoreAction`, `flagLoreAction`, pending buffer, gap persistence
- `src/librarian/librarian-ui.js` -- per-message dropdown injection
- `src/librarian/librarian-session.js` -- Emma conversation engine, session persistence
- `src/librarian/librarian-chat-tools.js` -- tools available inside Emma's conversation loop (NOT ToolManager)
- `src/librarian/librarian-prompts.js` -- bootstrap system prompts for guide-mode sessions
- `src/librarian/librarian-review.js` -- two-panel popup UI (editor + chat)
- `src/librarian/visibility.js` -- show/hide all Librarian surfaces
- `index.js` -- event handlers: `TOOL_CALLS_RENDERED`, `GENERATION_ENDED`, `MESSAGE_SWIPED`, `CHAT_CHANGED`
- `src/state.js` -- state variables

---

## 1. Tool Registration

**File:** `src/librarian/librarian.js`

### `registerLibrarianTools()`

Registers two tools with SillyTavern's `ToolManager`:

| Tool name | Action fn | `stealth` | `shouldRegister` guard |
|---|---|---|---|
| `dle_search_lore` | `searchLoreAction` | (absent) | `librarianEnabled && librarianSearchEnabled && isToolCallingSupported()` |
| `dle_flag_lore` | `flagLoreAction` | `true` | `librarianEnabled && librarianFlagEnabled && isToolCallingSupported()` |

Both tools set `formatMessage: () => null` (suppress default tool-result system message).

**Call sites:** `init()` at boot, lazy re-check inside `onGenerate()` (L214), and settings toggle handler.

**State read:** `librarianToolsRegistered` (state.js L222).
**State written:** `setLibrarianToolsRegistered(true)` on success.

### BUG-086: Re-verification on every call

Other extensions (or HMR cycles) can rebuild `ToolManager`'s internal `#tools` map, silently evicting DLE's tools. The local `librarianToolsRegistered` flag would still be `true`. Fix: every call to `registerLibrarianTools()` reads `ToolManager.tools`, checks both tool names are present, and force-re-registers if either is missing (L36-44).

### `ensureFunctionCallingEnabled()`

Called after successful registration (L136). Lazy-imports `openai.js`, sets `oai_settings.function_calling = true`, syncs the visible checkbox, and saves. Without this, ST silently drops registered tools from outbound requests.

**Gotcha:** If the user manually disables function calling elsewhere after Librarian enables it, tools stop working silently. There is no automatic re-assertion handler — the user must re-enable Librarian or function calling manually.

### `unregisterLibrarianTools()`

Calls `ToolManager.unregisterFunctionTool()` for both names, sets `librarianToolsRegistered = false`. Called from the settings toggle handler when Librarian is disabled.

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
| `pendingToolCalls.push(logEntry)` | Module-local buffer | `genAtStart === generationCount && lockEpochAtStart === generationLockEpoch && epoch === chatEpoch` |
| `sessionActivityLog.push(logEntry)` | Module-local array | Always |
| Analytics | `settings.analyticsData._librarian.totalGapSearches` | Always |
| Stats | `librarianSessionStats`, `librarianChatStats` | Always |

**Log entry shape:**
```js
{ type: 'search', query: string, resultCount: number, resultTitles: string[],
  tokens: number, timestamp: number, generation: number }
```

### BUG-295: Generation/epoch guards on pendingToolCalls

Snapshots `chatEpoch` (L357), `generationCount` (L364), and `generationLockEpoch` (L365) at call start. Only pushes to `pendingToolCalls` if all three still match at push time (L529). Prevents a swipe that clears the buffer from having its fresh buffer polluted by a late-resolving tool call from the previous generation.

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

**Side effects:** Same pattern as searchLoreAction -- pushes to `pendingToolCalls` and `sessionActivityLog` with generation/epoch guards. Tokens estimated at 10 (minimal overhead).

**Return text:** Includes "Do not acknowledge this flag -- continue seamlessly." to prevent the AI from narrating what it flagged.

### Overlap detection: `findSimilarGap()`

**File:** `src/librarian/librarian-tools.js`, L81-101

Tokenizes both queries via `tokenize()` (from BM25 module), computes Jaccard-like overlap ratio: `overlap / max(newSet.size, existingSet.size)`. Threshold: **>0.6** (60%). Only compares gaps with matching `type` and optionally `subtype`.

**Gotcha:** Uses `>` not `>=`, so exactly 60% overlap does NOT merge.

### Stealth flag

`dle_flag_lore` is registered with `stealth: true` (librarian.js L120). This tells ST to skip creating system messages and skip triggering a follow-up generation for flag tool calls. Without this, every flag would cause a visible "tool_invocations" system message and an empty continuation generation.

**Known limitation:** When the AI returns both `search_lore` and `flag_lore` in the same response, both are processed during the same `GENERATION_ENDED` consolidation pass. Ordering follows tool-call invocation order, not separate rounds.

---

## 4. Tool-Call Consolidation (GENERATION_ENDED)

**File:** `index.js`, L1234-1280

### Event handler: `GENERATION_ENDED`

Fires once per completed generation turn. Responsible for:

1. `consumePendingToolCalls()` -- returns and clears the module-local `pendingToolCalls` buffer (librarian-tools.js L55-59).
2. Early return if buffer empty or if `chatEpoch` changed (BUG-AUDIT-DP02, L1247).
3. Find target message: walks backward from end of `chat[]`, skips system messages and user messages, finds the last non-empty assistant message whose `.mes` is not `''` or `'...'` (L1252-1258).
4. Persist: `target.extra.deeplore_tool_calls = pendingCalls` + `saveMetadataDebounced()` (L1263-1264).
5. `injectLibrarianDropdown(targetIdx, pendingCalls)` -- DOM injection (L1265).
6. Hide intermediate assistant messages from tool-call rounds by setting `mesEl.style.display = 'none'` for all assistant messages between the target and the previous user message (L1271-1276).

### `consumePendingToolCalls()` (librarian-tools.js L55-59)

```js
export function consumePendingToolCalls() {
    const calls = pendingToolCalls;
    pendingToolCalls = [];
    return calls;
}
```

Returns the buffer by reference, then replaces it with a fresh empty array. Not a copy -- callers own the returned array.

### Persistence location

Tool call data lives on `message.extra.deeplore_tool_calls` (per-message), NOT in `chat_metadata`. This is different from `deeplore_lore_gaps` which is in `chat_metadata`.

### Cleanup on status elements

Also calls `_removeDleToolStatus()` (removes the "Consulting lore vault..." counter) and `_removePipelineStatus()` (removes "Choosing Lore..." status).

---

## 5. TOOL_CALLS_RENDERED Handler

**File:** `index.js`, L1219-1232

### Event handler: `TOOL_CALLS_RENDERED`

Fires each time ST renders tool invocation results in the chat. Receives `invocations` array.

**Logic:**

1. Guard: if not ALL invocations are DLE tools (`inv.name?.startsWith('dle_')`), return (L1221-1222). This means mixed DLE+non-DLE tool calls are not hidden.
2. Hide the system message DOM element for the last chat message (`chat.length - 1`) by setting `display: none` (L1224-1225).
3. Increment `_dleToolStatusCounts.search` or `.flag` per invocation (L1227-1229).
4. Call `_updateDleToolStatus()` to show/update the "Consulting lore vault..." counter element.

### `_updateDleToolStatus()` (index.js L1194-1210)

Creates or updates a `#dle-tool-status` div appended to `#chat`. Shows count like "Consulting lore vault... 2 searches, 1 flag". Auto-scrolls into view.

### `_removeDleToolStatus()` (index.js L1211-1214)

Resets counters to zero, removes the DOM element. Called by:
- `GENERATION_ENDED` handler
- `GENERATION_STOPPED` handler
- `MESSAGE_SWIPED` handler

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
| `CHAT_CHANGED` | (index.js L1696) | `clearSessionActivityLog()` + `clearPendingToolCalls()` (session state itself is per-chat, so it persists within the chat) |

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

**Tool execution:** Calls `executeToolCall(name, args, session)` from `librarian-chat-tools.js`. These are the Emma-internal tools (search_vault, get_entry, etc.), NOT the ToolManager-registered tools.

---

## 7. Librarian Chat Tools

**File:** `src/librarian/librarian-chat-tools.js`

These tools are available ONLY inside Emma's conversation loop (`sendMessage`). They are NOT registered with SillyTavern's `ToolManager`. Executed locally via `executeToolCall()`.

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
clearPendingToolCalls();              // always
```

**CHAT_CHANGED hydration (index.js L1689-1697):**
Regardless of this setting, `CHAT_CHANGED` always hydrates `loreGaps` from `chat_metadata.deeplore_lore_gaps` (normalizing legacy statuses), resets `loreGapSearchCount`, resets `librarianChatStats`, clears `sessionActivityLog`, and clears `pendingToolCalls`.

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

Callback-based observer pattern. `setLoreGaps()` calls it automatically. Also called explicitly by `searchLoreAction` and `flagLoreAction` after pushing to pending buffer (to update the Activity sub-tab even when `persistGaps` was not called).

### `stripDleSystemMessages` (onGenerate, index.js L244-276)

Runs after lock acquisition. Walks `chat[]` backward, splicing out:
- System messages where ALL `tool_invocations` are DLE tools (L257-260).
- Intermediate assistant messages within DLE tool-call turns (L270-272).
- For mixed DLE+non-DLE tool messages: filters out only DLE invocations from the array (L262).

### Session stats vs chat stats

| Variable | Scope | Reset trigger |
|---|---|---|
| `librarianSessionStats` | Page load | Never (survives CHAT_CHANGED) |
| `librarianChatStats` | Per-chat | `CHAT_CHANGED` (index.js L1695) |

Both track `{ searchCalls, flagCalls, estimatedExtraTokens }`.

### Activity feed: `buildLibrarianActivityFeed()`

**File:** `src/librarian/librarian-tools.js`, L210-255

Merges session activity log (in-memory) with persistent gap records (loreGaps). Deduplicates by `type:query:timestamp/2000` key. Persistent search gaps are excluded (only live session searches shown). Returns newest-first array consumed by both the drawer and the popup.
