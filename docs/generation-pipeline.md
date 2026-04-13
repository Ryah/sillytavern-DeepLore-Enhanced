# Generation Pipeline Deep Dive

The generation pipeline is DLE's core — most regressions originate here. This doc traces every step of `onGenerate()` in `index.js` L188-842.

---

## Overview

`onGenerate(chatMessages, contextSize, abort, type)` is the generation interceptor, called by SillyTavern's interceptor system before each generation. It is registered on `globalThis.deepLoreEnhanced_onGenerate` (L845).

**Inputs:** `chatMessages` (filtered copy of ST's chat array — NOT the global `chat`; pushing to it loses data), `contextSize` (context window tokens), `abort` (callback to prevent ST's generation — used by agentic loop dispatch), `type` (generation type string).

**Side effects:** Calls `setExtensionPrompt()` to inject lore into the prompt. When Librarian agentic loop is active: calls `abort()`, runs its own generation loop, and inserts a message via `addOneMessage()`. Mutates `chat_metadata` (injection logs, counts, swipe keys). Mutates state variables (trackers, sources, trace).

**The entire function is guarded by `generationLock`** — only one pipeline can run at a time.

**Pipeline status element:** `_updatePipelineStatus` prepends to `#form_sheld` (not `#chat`). `_removePipelineStatus` uses a slide-down animation (`dle-toast-out` class + `animationend` listener). Pipeline phases: `"Choosing Lore…"` → `"Consulting vault…"` (new `consulting` phase, triggered when onStatus text includes "Consulting") → `"Generating…"`.

---

## Phase 1: Early Guards (L188-205)

```
onGenerate(chatMessages)
  → Skip if type === 'quiet' or !settings.enabled
  → Skip if skipNextPipeline (consume and clear flag, early return)
  → Skip if last message has tool_invocations or is_system (tool-call continuation from other extensions)
```

1. **Quiet generations** (type `'quiet'`): Background API calls (e.g., summarization). No lore injection.
2. **`skipNextPipeline` bypass**: One-shot flag checked after the quiet check and before the tool-call continuation check. When true, the entire DLE pipeline is skipped (early return). The flag is consumed immediately (reset to `false`). Used by `/dle-review` to prevent the DLE pipeline from running on vault review generations — the review needs a clean generation with no lore injection.
3. **Tool-call continuations** (L215-222): When the last message has `extra.tool_invocations` or `is_system`, ST is re-calling Generate after a tool invocation from another extension using ST's ToolManager. Lore from the original generation is still in context. Re-running would waste tokens and corrupt analytics. Records `{ skipped: true, reason: 'tool_call_continuation' }` in the flight recorder. DLE's own Librarian uses the agentic loop (not ToolManager), so DLE tool calls never trigger this guard.

---

## Phase 2: Pre-Lock Setup (L212-236)

```
  → Check generationLock
    → If locked >30s: force-release with lockEpoch bump (BUG-274)
    → If locked <30s: warn and return (skip this generation)
  → Acquire lock: setGenerationLock(true)
  → Show status: "Choosing Lore…"
```

**Lock acquisition** (L219-236): `setGenerationLock(true)` increments `generationLockEpoch` (in the setter at `state.js` L190). This epoch is captured at L290 and checked at every commit point.

**Force-release** (L221-229): After 30s, the lock is considered stuck. `generationLockEpoch` is bumped BEFORE releasing, so the stuck pipeline's late writes fail every `lockEpoch === generationLockEpoch` guard. Records `{ forceRelease: true, lockAgeMs, oldEpoch, newEpoch }` in the flight recorder. If lock contention is detected but under 30s, records `{ skipped: true, reason: 'lock_contention' }` and returns.

---

## Phase 3: Epoch Capture & Abort Setup (L288-306)

```
  → Capture chatEpoch and generationLockEpoch
  → Create AbortController for pipeline cancellation
  → Wire GENERATION_STOPPED and CHAT_CHANGED to abort
  → Wire STREAM_TOKEN_RECEIVED (once) to remove status
```

**Epoch capture** (L288-290):
```javascript
const epoch = chatEpoch;
const lockEpoch = generationLockEpoch;
```
These are checked after every `await` and before every state mutation.

**AbortController** (L298-301): `pipelineAbort.signal` is passed to `runPipeline` and AI calls. The Stop button triggers `GENERATION_STOPPED` which aborts the controller.

---

## Phase 3b: Diagnostic Breadcrumb (after epoch capture)

When `debugMode` is enabled, a diagnostic breadcrumb is logged at pipeline entry after `ensureIndexFresh` completes. Includes `chatMessageCount`, `vaultSnapshotSize`, and `generationNumber`. This is purely diagnostic — no state mutation.

---

## Phase 4: Index Refresh (L307-361)

```
try {
  → Clear stale dedup logs on first generation after hydration
  → ensureIndexFresh() with 60s timeout
  → On timeout: fall back to stale data (if any), or return
  → POST-AWAIT EPOCH CHECK (BUG-299)
  → Snapshot vault: getWriterVisibleEntries() (excludes guide entries)
  → If snapshot empty: warn and return
}
```

**Index timeout** (L323-336): `Promise.race` with 60s timer. If timeout wins and `vaultIndex.length > 0`, proceeds with stale data. If vault is empty, returns (no lore to inject).

**Epoch re-check** (L341-344): `CHAT_CHANGED` may fire during the up-to-60s `ensureIndexFresh` await. Without this check, the pipeline would tag a stale snapshot with the new chat's swipe keys. On mismatch, records `{ discarded: true, reason: 'chat_changed_during_index' }` in the flight recorder.

**Guide entry filter** (L348): `getWriterVisibleEntries()` = `vaultIndex.filter(e => !e.guide)`. The writing AI must never see guide entries.

---

## Phase 5: Swipe Rollback (L366-391)

```
  → Compute swipeKey: `${msgIdx}|${swipe_id}`
  → If lastGenerationTrackerSnapshot.swipeKey matches: restore tracker state
  → Take fresh snapshot for THIS generation
```

**Swipe detection**: If the swipe key matches the previous generation's snapshot key, this is a regen/swipe. Restore cooldownTracker, decayTracker, consecutiveInjections, injectionHistory, and generationCount from the snapshot.

**Snapshot capture** (L383-390): Always takes a fresh snapshot with the current swipe key. This is the restore point for the next generation if it's a swipe.

---

## Phase 6: Pipeline Execution (L393-406)

```
  → Gather context: ctx, pins, blocks, folderFilter from chat_metadata
  → runPipeline(chatMessages, vaultSnapshot, ctx, {pins, blocks, folderFilter, signal, onStatus})
  → Returns: { finalEntries, matchedKeys, trace }
  → Check abort signal
```

`runPipeline()` is in `src/pipeline/pipeline.js`. It runs the core matching logic based on mode:

| Mode | Flow |
|---|---|
| `keywords-only` | `matchEntries(chat)` → keyword + BM25 matches → `applyFolderFilter()` |
| `two-stage` | `matchEntries(chat)` → wiki-link expansion → optional `hierarchicalPreFilter()` → `applyContextualGating()` → `applyFolderFilter()` → `buildCandidateManifest()` → `aiSearch(chat, manifest)` |
| `ai-only` | Full vault → optional `hierarchicalPreFilter()` → `applyContextualGating()` → `applyFolderFilter()` → `buildCandidateManifest()` → `aiSearch()` |

**Note:** `applyContextualGating()` and `applyFolderFilter()` run _inside_ `runPipeline()` as pre-filters (so the AI only sees candidates that can actually be injected), and again post-pipeline in Phase 7 (Stage 2 / Stage 2b) as the authoritative gate on final entries. See `stages-and-gating.md` for stage details.

### Hierarchical Pre-Filter Toggle

Controlled by `settings.hierarchicalPreFilter` (default: `false`, `settings.js` L196). When enabled and candidate count exceeds `HIERARCHICAL_THRESHOLD = 40` (`ai.js` L311), a lightweight AI call clusters candidates by category and asks which categories are relevant, returning a reduced candidate set before the main AI search.

- **Returns:** `null` (skip, use all candidates) or a filtered array (may be empty — empty is a valid result meaning no categories matched)
- **BUG-396 rescue:** Entries whose primary keywords are explicitly mentioned in the chat are re-added after filtering, preventing the pre-filter from silently dropping highly-relevant entries
- **Circuit breaker:** Uses `tryAcquireHalfOpenProbe()` / `releaseHalfOpenProbe()` — its probe slot is independent of the main `aiSearch()` call
- **Source:** `src/ai/ai.js` L321-450

---

## Phase 7: Post-Pipeline Stages (L407-536)

These run in `index.js`, not in `runPipeline()`. Each has its own trace recording.

### Stage 1: Pin/Block (L409-410)
```javascript
const policy = buildExemptionPolicy(vaultSnapshot, pins, blocks);
let finalEntries = applyPinBlock(pipelineEntries, vaultSnapshot, policy, matchedKeys);
```
Adds pinned entries (as `constant=true, priority=10`). Removes blocked entries. See `stages-and-gating.md`.

### Stage 2: Contextual Gating (L413-419)
```javascript
finalEntries = applyContextualGating(finalEntries, ctx, policy, settings.debugMode, settings, fieldDefs);
```
Filters by era/location/scene_type/character_present/custom fields. ForceInject entries exempt.

### AI Fallback Warning (L421-432)
If `trace.aiFallback` is true, shows user-facing warning with error classification.

### Empty Check + clearPrompts (L438-449)
If no entries remain, clears prompts (with epoch guard) and returns. Similar epoch-guarded clearPrompts+return blocks also follow Stage 3 (L460-469) and Stage 4 (L474-483) in case those stages remove all remaining entries.

### Stage 3: Re-injection Cooldown (L452-469)
```javascript
finalEntries = applyReinjectionCooldown(finalEntries, policy, injectionHistory, generationCount, settings.reinjectionCooldown, settings.debugMode);
```
Skips entries injected within `reinjectionCooldown` generations. ForceInject exempt.

### Stage 4: Requires/Excludes (L471-483)
```javascript
const { result: gated, removed: gatingRemoved } = applyRequiresExcludesGating(finalEntries, policy, settings.debugMode);
```
AND logic for `requires`, OR logic for `excludes`. ForceInject exempt.

### Stage 5: Strip Dedup (L485-493)
```javascript
postDedup = applyStripDedup(gated, policy, chat_metadata.deeplore_injection_log, settings.stripLookbackDepth, settings, settings.debugMode);
```
Removes entries with same position+depth+role+contentHash in recent injection log.

### Stage 6: Format and Group (L496-498)
```javascript
const { groups, count, totalTokens, acceptedEntries } = formatAndGroup(postDedup, settings, PROMPT_TAG_PREFIX);
```
Applies token budget (`maxTokensBudget`), entry limit (`maxEntries`), groups by injection position/depth/role. Returns `groups[]` ready for `setExtensionPrompt`. See `core/matching.js`.

### Trace Publishing (L502-536)
Enriches `trace` with gating/budget/dedup details. **Epoch-guarded** (L520): only publishes trace and pushes activity if both epochs match.

---

## Phase 8: Commit Phase (L538-610)

```
  → FINAL EPOCH CHECK (L540, L548)
  → If groups.length > 0:
    → clearPrompts() (L553)
    → For each group:
      → Outlet groups (position -1): setExtensionPrompt with outlet tag
      → Prompt List mode: write to PM entry directly
      → Extension mode: setExtensionPrompt with position/depth/role
    → Tag lastInjectionSources + lastInjectionEpoch for Cartographer
  → Else (no groups):
    → clearPrompts() (L603) — stale prompts from prior generation
```

**Two epoch checks** before committing (L540, L548). Both must pass.

**clearPrompts placement**: Two sites — L553 inside the `if (groups.length > 0)` block (clear-before-replace), and L603 in the `else` branch (clear stale prompts when no groups survived). Earlier empty-check branches (L448, L467, L481) also call clearPrompts with their own epoch guards.

**Injection modes:**
- **Extension mode** (default): `setExtensionPrompt(tag, text, position, depth, allowWIScan, role)` for each group
- **Prompt List mode**: Writes content directly to PM entries (`pmEntry.content = group.text`). PM's drag order controls placement.
- **Outlet groups** (position -1): Always use `setExtensionPrompt` regardless of mode, for `{{outlet::name}}` macro

**Auxiliary prompts** (L612-668): Author's Notebook and AI Notebook injection via `_injectAuxPrompt()` helper, which handles the PM-vs-extension_prompts ladder.

---

## Phase 8b: Agentic Loop Dispatch (L776-866)

After pipeline commit and `_updatePipelineStatus('Generating...')`, DLE fires `notifyInjectionSourcesReady()` (so the drawer can render the Why? tab early, before generation completes), then checks whether to run its own generation loop:

```
  → notifyInjectionSourcesReady()          // Drawer renders Why? tab early
  → Guard: type !== 'continue' && type !== 'append' && type !== 'appendFinal'
    → If any of those: fall through to ST's generation
  → If suppressNextAgenticLoop:
    → Reset flag to false (consumed)
    → Fall through to ST's normal generation
  → Else if librarianEnabled && isToolCallingSupported():
    → abort()                              // Prevent ST from generating
    → setSendButtonState(true)             // C1: Re-entrancy guard (abort re-enables send)
    → deactivateSendButtons()
    → setLoreGapSearchCount(0)             // C6: Reset search counter
    → buildChatMessages(chatMessages, pipelineContext, injectedTitles, settings)
    → runAgenticLoop(messages, signal, epoch, lockEpoch, ..., onProse)
      → During loop: onProse(prose) fires on write() tool call (PRIMARY path)
        → saveReply({ type, getMessage })  // Message lifecycle (events, swipe handling)
        → saveChatConditional()            // Disk save (abort() prevents ST's post-gen save)
    → POST-AWAIT EPOCH CHECK
    → If result.prose (FALLBACK — AI returned text without write() tool):
      → saveReply + saveChatConditional    // Same as above, but post-loop
    → injectLibrarianDropdown (if enabled)
    → finally:
      → setSendButtonState(false) + activateSendButtons()
      → emit GENERATION_ENDED
    → return (don't fall through to ST's generation)
  → Else: fall through to ST's normal generation
  → Runtime warning: if librarianEnabled && !isToolCallingSupported(), dedupWarning fires
```

**`suppressNextAgenticLoop`**: One-shot flag exposed via the skip-tools toggle button in the drawer status zone. When true, the Librarian agentic loop is skipped for that generation (lore is still injected via `setExtensionPrompt`, but the generation falls through to ST's normal path instead of DLE's agentic loop). The flag is reset in the `if (suppressNextAgenticLoop)` branch, BEFORE the `else if` agentic dispatch — see gotchas.md for why this placement matters.

**Runtime warning**: After the agentic dispatch block, a `dedupWarning` fires when `librarianEnabled && !isToolCallingSupported()`. This warns the user that the Librarian requires function calling support, which the current provider/model does not offer.

The agentic loop runs the state machine (SEARCH -> FLAG -> DONE), calling `searchLoreAction` and `flagLoreAction` directly. `onProse` is async and awaited — it calls `saveReply({ type })` + `saveChatConditional()` so the message is fully created, events processed, and saved to disk before the FLAG phase begins. `type` from `onGenerate` is forwarded to `saveReply` for correct swipe/regen behavior. Tool activity is stored directly on `message.extra.deeplore_tool_calls`.

**C9 keepalive:** The agentic loop calls `setGenerationLockTimestamp(Date.now())` before every API call and before tool processing. Without this, the 30s stale-lock detector in Phase 2 would force-release the lock mid-loop, causing epoch mismatch on the next iteration.

**C1 re-entrancy:** `abort()` calls ST's `unblockGeneration()`, which re-enables the send button. The dispatch immediately locks it again via `setSendButtonState(true)`. Restored in `finally`.

---

## Phase 9: Post-Commit Tracking (L670-761)

All epoch-guarded and lock-guarded.

### Stage 7: Track Generation (L670-675)
```javascript
trackGeneration(injectedEntries, generationCount, cooldownTracker, decayTracker, injectionHistory, settings);
```
Updates per-entry cooldown, decay, and injection history maps.

### Injection Dedup Log (L684-703)
If `stripDuplicateInjections` enabled, records entries with position/depth/role/contentHash to `chat_metadata.deeplore_injection_log`. Bounded by `stripLookbackDepth + 1`.

### Stage 8: Analytics (L705-714)
`recordAnalytics(postDedup, injectedEntries, settings.analyticsData)`. Persisted every 5 generations to reduce write amplification.

### Stage 9: Per-Chat Injection Counts (L716-761)
- Decrements prior swipe's keys from `chatInjectionCounts`
- Increments this round's keys
- Prunes `perSwipeInjectedKeys` to last 10 message slots
- Persists to `chat_metadata.deeplore_chat_counts` and `deeplore_swipe_injected_keys`
- Uses `saveMetadata()` (immediate, not debounced — BUG-306)

---

## Phase 10: Finally Block (L812-841)

**Always runs** — even on errors and early returns.

```
finally {
  → Tear down abort listeners (GENERATION_STOPPED, CHAT_CHANGED, STREAM_TOKEN_RECEIVED)
  → Remove pipeline status element
  → If pipelineRan AND epochs match:
    → Increment generationCount
    → decrementTrackers(cooldownTracker, decayTracker, injectedEntries, settings, consecutiveInjections)
  → If lockEpoch matches: release generation lock
  → If both epochs match: notifyPipelineComplete()
}
```

**decrementTrackers** (L825): Always runs if `pipelineRan` is true, even with zero matches. Without this, cooldown timers freeze permanently.

**Conditional lock release** (L832-834): `if (lockEpoch === generationLockEpoch)` — prevents a force-released stale pipeline from unlocking the newer pipeline. On mismatch, records `{ lockReleaseBlocked: true, reason: 'epoch_mismatch' }` in the flight recorder.

**Conditional pipeline-complete notification** (L838-840): Both epoch AND lockEpoch must match. Prevents a stale pipeline from triggering drawer re-renders for the wrong chat. On mismatch, records `{ discarded: true, reason: 'stale_pipeline_tracking_skipped' }`.

---

## Critical Invariants Summary

1. `clearPrompts` in the `groups.length > 0` branch is NEVER called without verified replacement data in hand (the `else` branch and early-exit empty checks intentionally clear stale prompts with no replacement)
2. All epoch guards are re-checked after every `await`
3. Stale pipelines (force-released lock) bail at every commit point via `lockEpoch` check
4. The pipeline is NOT reentrant — `generationLock` prevents concurrent runs
5. Tool-call continuations skip the pipeline entirely
6. Guide entries are filtered out at L348 via `getWriterVisibleEntries()` — they never reach the writing AI
7. `pipelineRan` controls whether `decrementTrackers` runs in `finally` — set to `true` at L364 only after the vault snapshot is confirmed non-empty
8. When Librarian is enabled + tool calling supported, DLE aborts ST's generation and runs its own agentic loop. The loop calls `setGenerationLockTimestamp` as keepalive (C9) and uses `setSendButtonState` as re-entrancy guard (C1).
9. `onGenerate`'s first parameter is `chatMessages` (a filtered copy), NOT the global `chat`. Never push to it — use the global `chat` import for message creation.
10. `notifyInjectionSourcesReady()` fires before the agentic loop dispatch, allowing the drawer to render the Why? tab early.
11. `onProse` in the agentic loop is async and must be awaited — it runs `saveReply` + `saveChatConditional`.
12. `type` from `onGenerate` is forwarded to `saveReply` for correct swipe/regen behavior. Continue/append/appendFinal types fall through to ST.
13. `skipNextPipeline` is consumed before the tool-call continuation check — it provides a clean early exit for `/dle-review` without touching any pipeline state.
14. `suppressNextAgenticLoop` is consumed in its own `if` branch before `else if` agentic dispatch — the reset MUST happen there, not in `finally`, to ensure it's consumed even when the agentic loop doesn't fire.

---

## Call Graph Summary

```
onGenerate(chatMessages, contextSize, abort, type)             [index.js L188]
  ├─ setGenerationLock(true)                                   [L236]
  ├─ ensureIndexFresh()                                        [L326, with 60s timeout]
  ├─ getWriterVisibleEntries()                                 [L348]
  ├─ (swipe rollback from lastGenerationTrackerSnapshot)       [L369-391]
  ├─ runPipeline(chatMessages, vaultSnapshot, ctx, opts)        [L401]
  │   ├─ matchEntries(chatMessages, snapshot)                   [src/pipeline/pipeline.js]
  │   ├─ hierarchicalPreFilter(entries, chatMessages, signal)   [optional, ai-only + two-stage modes]
  │   ├─ buildCandidateManifest(entries)                       [src/ai/ai.js → manifest.js]
  │   └─ aiSearch(chat, manifest, header, snapshot, cands, signal) [src/ai/ai.js]
  ├─ buildExemptionPolicy(vaultSnapshot, pins, blocks)         [src/stages.js]
  ├─ applyPinBlock(entries, vaultSnapshot, policy, matchedKeys)[src/stages.js]
  ├─ applyContextualGating(entries, ctx, policy, ...)          [src/stages.js]
  ├─ applyReinjectionCooldown(entries, policy, ...)            [src/stages.js]
  ├─ applyRequiresExcludesGating(entries, policy, ...)         [src/stages.js]
  ├─ applyStripDedup(entries, policy, ...)                     [src/stages.js]
  ├─ formatAndGroup(entries, settings, PROMPT_TAG_PREFIX)       [core/matching.js]
  ├─ clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, ...)   [core/pipeline.js]
  ├─ setExtensionPrompt(tag, text, pos, depth, wiScan, role)   [ST API]
  ├─ notifyInjectionSourcesReady()                              [state.js — drawer Why? tab]
  ├─ (suppressNextAgenticLoop check — if true, consume flag, fall through to ST)
  ├─ (Agentic Loop Dispatch — else if librarianEnabled && isToolCallingSupported && not continue/append):
  │   ├─ abort()                                               [prevent ST generation]
  │   ├─ buildChatMessages(chatMessages, pipelineCtx, injTitles) [agentic-messages.js]
  │   ├─ runAgenticLoop(messages, signal, epoch, lockEpoch, onProse) [agentic-loop.js]
  │   │   ├─ callWithTools(messages, tools, toolChoice, ...)   [agentic-api.js → CMRS]
  │   │   ├─ searchLoreAction(args)                            [librarian-tools.js]
  │   │   ├─ flagLoreAction(args)                              [librarian-tools.js]
  │   │   └─ await onProse?.(prose)                            [async — saveReply + saveChatConditional]
  │   ├─ saveReply({ type, getMessage })                       [ST API — message lifecycle]
  │   ├─ saveChatConditional()                                 [ST API — disk save]
  │   └─ return (skip ST generation)
  ├─ (Runtime warning: dedupWarning if librarianEnabled && !isToolCallingSupported)
  ├─ trackGeneration(entries, genCount, trackers, settings)     [src/stages.js]
  ├─ recordAnalytics(matched, injected, analyticsData)         [src/stages.js]
  └─ finally:
      ├─ decrementTrackers(cooldown, decay, injected, ...)     [src/stages.js]
      ├─ setGenerationLock(false)                               [conditional on lockEpoch]
      └─ notifyPipelineComplete()                               [conditional on both epochs]
```
