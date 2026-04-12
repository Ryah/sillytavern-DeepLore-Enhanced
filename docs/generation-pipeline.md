# Generation Pipeline Deep Dive

The generation pipeline is DLE's core — most regressions originate here. This doc traces every step of `onGenerate()` in `index.js` L188-842.

---

## Overview

`onGenerate(chat, contextSize, abort, type)` is the generation interceptor, called by SillyTavern's interceptor system before each generation. It is registered on `globalThis.deepLoreEnhanced_onGenerate` (L845).

**Inputs:** `chat` (message array, mutable), `contextSize` (context window tokens), `abort` (unused), `type` (generation type string).

**Side effects:** Calls `setExtensionPrompt()` to inject lore into the prompt. Mutates `chat[]` (strips DLE tool messages). Mutates `chat_metadata` (injection logs, counts, swipe keys). Mutates state variables (trackers, sources, trace).

**The entire function is guarded by `generationLock`** — only one pipeline can run at a time.

---

## Phase 1: Early Guards (L188-205)

```
onGenerate(chat)
  → Skip if type === 'quiet' or !settings.enabled
  → Skip if last message has tool_invocations (tool-call continuation)
```

1. **Quiet generations** (type `'quiet'`): Background API calls (e.g., summarization). No lore injection.
2. **Tool-call continuations** (L196-205): When the last message has `extra.tool_invocations`, ST is re-calling Generate after a tool invocation. Lore from the original generation is still in context. Re-running would waste tokens and corrupt analytics. Records `{ skipped: true, reason: 'tool_call_continuation' }` in the flight recorder.

---

## Phase 2: Pre-Lock Setup (L212-236)

```
  → Lazy Librarian tool registration (if enabled)
  → Check generationLock
    → If locked >30s: force-release with lockEpoch bump (BUG-274)
    → If locked <30s: warn and return (skip this generation)
  → Acquire lock: setGenerationLock(true)
  → Show status: "Choosing Lore…"
```

**Lazy Librarian registration** (L214-216): `registerLibrarianTools()` is retried here because `init()` may run before ST's `extension_settings` are fully hydrated.

**Lock acquisition** (L219-236): `setGenerationLock(true)` increments `generationLockEpoch` (in the setter at `state.js` L190). This epoch is captured at L290 and checked at every commit point.

**Force-release** (L221-229): After 30s, the lock is considered stuck. `generationLockEpoch` is bumped BEFORE releasing, so the stuck pipeline's late writes fail every `lockEpoch === generationLockEpoch` guard. Records `{ forceRelease: true, lockAgeMs, oldEpoch, newEpoch }` in the flight recorder. If lock contention is detected but under 30s, records `{ skipped: true, reason: 'lock_contention' }` and returns.

---

## Phase 3: Tool Message Stripping (L244-276)

**After lock acquisition** (critical — see gotchas.md #8):

```
  → Strip DLE tool_invocation system messages from chat[]
  → Strip intermediate assistant messages from DLE tool-call rounds
```

Walks `chat[]` backwards. For each message:
- System messages with `extra.tool_invocations` where all invocations are `dle_*`: splice out entirely
- System messages with mixed invocations: filter out only the `dle_*` entries
- Intermediate assistant messages in DLE tool turns (not the final response): splice out

---

## Phase 4: Epoch Capture & Abort Setup (L288-306)

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

## Phase 5: Index Refresh (L307-361)

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

## Phase 6: Swipe Rollback (L366-391)

```
  → Compute swipeKey: `${msgIdx}|${swipe_id}`
  → If lastGenerationTrackerSnapshot.swipeKey matches: restore tracker state
  → Take fresh snapshot for THIS generation
```

**Swipe detection**: If the swipe key matches the previous generation's snapshot key, this is a regen/swipe. Restore cooldownTracker, decayTracker, consecutiveInjections, injectionHistory, and generationCount from the snapshot.

**Snapshot capture** (L383-390): Always takes a fresh snapshot with the current swipe key. This is the restore point for the next generation if it's a swipe.

---

## Phase 7: Pipeline Execution (L393-406)

```
  → Gather context: ctx, pins, blocks, folderFilter from chat_metadata
  → runPipeline(chat, vaultSnapshot, ctx, {pins, blocks, folderFilter, signal, onStatus})
  → Returns: { finalEntries, matchedKeys, trace }
  → Check abort signal
```

`runPipeline()` is in `src/pipeline/pipeline.js`. It runs the core matching logic based on mode:

| Mode | Flow |
|---|---|
| `keywords-only` | `matchEntries(chat)` → keyword + BM25 matches |
| `two-stage` | `matchEntries(chat)` → wiki-link expansion → optional `hierarchicalPreFilter()` → `buildCandidateManifest()` → `aiSearch(chat, manifest)` |
| `ai-only` | Full vault → optional `hierarchicalPreFilter()` → `buildCandidateManifest()` → `aiSearch()` |

All modes apply folder filtering if `folderFilter` is set. See `stages-and-gating.md` for stage details.

---

## Phase 8: Post-Pipeline Stages (L407-536)

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

## Phase 9: Commit Phase (L538-610)

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

## Phase 10: Post-Commit Tracking (L670-761)

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

## Phase 11: Finally Block (L812-841)

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

---

## Call Graph Summary

```
onGenerate(chat, contextSize, abort, type)                    [index.js L188]
  ├─ registerLibrarianTools()                                  [lazy, L214]
  ├─ setGenerationLock(true)                                   [L236]
  ├─ (strip DLE tool messages from chat[])                     [L244-276]
  ├─ ensureIndexFresh()                                        [L326, with 60s timeout]
  ├─ getWriterVisibleEntries()                                 [L348]
  ├─ (swipe rollback from lastGenerationTrackerSnapshot)       [L369-391]
  ├─ runPipeline(chat, vaultSnapshot, ctx, opts)               [L401]
  │   ├─ matchEntries(chat, snapshot)                          [src/pipeline/pipeline.js]
  │   ├─ hierarchicalPreFilter(entries, chat, signal)           [optional, ai-only + two-stage modes]
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
  ├─ trackGeneration(entries, genCount, trackers, settings)     [src/stages.js]
  ├─ recordAnalytics(matched, injected, analyticsData)         [src/stages.js]
  └─ finally:
      ├─ decrementTrackers(cooldown, decay, injected, ...)     [src/stages.js]
      ├─ setGenerationLock(false)                               [conditional on lockEpoch]
      └─ notifyPipelineComplete()                               [conditional on both epochs]
```
