# Gotchas — Read Before You Touch Anything

Every item here has caused a regression. Read this before modifying pipeline, state, or lifecycle code.

---

## 1. Epoch Guards

**Rule:** Every write to state or `chat_metadata` after an `await` MUST re-check `epoch === chatEpoch`. Every write to prompts or tracking MUST also check `lockEpoch === generationLockEpoch`.

**Why:** `CHAT_CHANGED` can fire at any moment (user switches chat while pipeline runs). Without the guard, a stale pipeline writes data to the wrong chat's metadata, corrupts cooldown/decay maps, or wipes the new pipeline's prompts.

**Pattern:**
```javascript
const epoch = chatEpoch;          // capture at function start
const lockEpoch = generationLockEpoch;
// ... await something ...
if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) return;
// NOW safe to write
```

**Where in code:** `index.js` L288-290 (capture), L341, L444, L463, L477, L540, L548, L673, L707, L723, L823, L832, L838 (checks). Missing a single check = cross-chat data corruption.

---

## 2. clearPrompts Timing

**Rule:** NEVER call `clearPrompts()` without verified replacement data in hand. NEVER call it before the commit phase.

**Why:** `clearPrompts` deletes all DLE-managed entries from `extension_prompts`. If an early return fires after clearing but before setting new prompts, lore silently disappears. If a stale pipeline reaches `clearPrompts`, it wipes prompts the new pipeline just set.

**Where in code:** `index.js` L553 (correct — inside the `groups.length > 0` block, after final epoch check). Lines L448, L467, L481 (no-match/cooldown-empty/gating-empty branches — guarded by epoch check first).

---

## 3. State Mutation Scoping

**Rule:** Know the reset scope of every state variable before touching it.

| Scope | Reset trigger | Examples |
|---|---|---|
| Session | Page load only | `aiSearchStats`, `librarianSessionStats` |
| Chat | `CHAT_CHANGED` | `cooldownTracker`, `decayTracker`, `consecutiveInjections`, `injectionHistory`, `generationCount`, `chatInjectionCounts`, `perSwipeInjectedKeys`, `librarianChatStats` |
| Generation | Each `onGenerate` run | `loreGapSearchCount` (always reset — L279, unconditional) |

**Why:** Resetting a session-scoped stat on chat change loses cross-chat totals. NOT resetting a chat-scoped tracker on chat change leaks stale data into the new chat.

---

## 4. trackerKey vs Bare Title

**Rule:** ALWAYS use `trackerKey(entry)` (format: `${vaultSource}:${title}`) for Map keys. Never use bare `entry.title`.

**Why:** Multi-vault support means the same title can exist in different vaults. Bare titles collide, causing one vault's cooldown/analytics to overwrite another's.

**Where:** `src/state.js` L91-93. Used in: `cooldownTracker`, `injectionHistory`, `decayTracker`, `consecutiveInjections`, `chatInjectionCounts`, `perSwipeInjectedKeys`, `analyticsData`.

---

## 5. Guide Entry Isolation

**Rule:** `lorebook-guide` entries MUST NOT reach the writing AI through any path. Use `getWriterVisibleEntries()` instead of `vaultIndex` for anything the writing AI sees.

**Safe to show in:** Drawer Browse tab, graph, diagnostics, Librarian's `get_writing_guide` tool.

**Where:** `src/state.js` L113-115 (`getWriterVisibleEntries`). Called at `index.js` L348 (pipeline snapshot). If you add a new path that sends vault data to the AI, it MUST go through this filter.

---

## 6. Tool-Call Continuations

**Rule:** When `lastMsg.extra.tool_invocations` exists, skip the pipeline entirely.

**Why:** ST re-calls Generate after each tool invocation. Lore from the original generation is still in context. Re-running the pipeline wastes tokens (especially the AI search sidecar), produces misleading analytics, and can corrupt tracker state.

**Where:** `index.js` L196-205.

---

## 7. Generation Lock

**Rule:** The generation lock uses three variables: `generationLock` (boolean), `generationLockTimestamp` (ms), `generationLockEpoch` (counter). A stale lock auto-releases after 30s with an epoch bump.

**Critical invariant:** A force-released stale pipeline MUST NOT release the newer pipeline's lock. The pattern is:
```javascript
if (lockEpoch === generationLockEpoch) setGenerationLock(false);
```

**Why:** Without the lockEpoch check, the stale pipeline's `finally` block releases the new pipeline's lock, allowing a third concurrent pipeline to start.

**Where:** `index.js` L219-235 (lock acquisition + stale detection), L832-834 (conditional release in finally). `src/state.js` L182-193 (setter increments epoch on acquire).

---

## 8. DLE System Message Stripping

**Rule:** Strip DLE tool-call messages from `chat[]` AFTER lock acquisition, never before.

**Why:** Stripping before the lock means a contended early return (lock held by another pipeline) still mutates `chat[]`. The splice leaks to other ST interceptors with no rollback path.

**Where:** `index.js` L207-210 (comment explaining the placement), L244-276 (actual strip logic, after `setGenerationLock(true)` at L236).

---

## 9. Swipe Tracking

**Rule:** Swipe keys use `${msgIdx}|${swipe_id}`, NOT content hashing.

**Why (BUG-291/292/293):** Content hashing failed because:
- Alternate-swipe navigation changes content → new hash → treated as fresh gen → tracker drift
- Delete + regenerate produces same content → hash collision → false rollback
- The slot+swipe_id key is stable across both scenarios

**Where:** `index.js` L366-391 (rollback logic), L716-761 (per-swipe injection count tracking). `src/state.js` L162-170 (state variable + comment).

---

## 10. AI Circuit Breaker

**Rule:** `isAiCircuitOpen()` is a **pure query** — use for UI/status. `tryAcquireHalfOpenProbe()` is the **mutation gate** — use ONLY in actual AI call paths.

**Why (BUG-AUDIT-1/2):** If UI code calls `tryAcquireHalfOpenProbe`, it steals the probe slot from the real AI call, causing the circuit to stay open indefinitely.

**Additional rules:**
- Throttle failures and user aborts do NOT trip the breaker (they're not service failures)
- `hierarchicalPreFilter` uses `releaseHalfOpenProbe()` — its outcome shouldn't affect the breaker since `aiSearch()` handles its own probing
- Stale probes auto-reset after 60s (`AI_PROBE_TIMEOUT`)

**Where:** `src/state.js` L246-350 (full state machine with comments).

---

## 11. Settings Cache (Removed — BUG-088)

**Rule:** `getSettings()` no longer caches. Every call runs all passes (default-fill, numeric coercion, validation, migrations) idempotently. `invalidateSettingsCache()` is retained as a **no-op** for call-site compatibility. You do NOT need to call it — but calling it is harmless.

**Why (historical):** The old cache required every mutator to remember `invalidateSettingsCache()`. BUG-088 removed the cache because the invalidation discipline was brittle. The `SETTINGS_UPDATED` event handler still calls the no-op for backward compatibility.

**Where:** `settings.js` L414-430 — BUG-088 comment + no-op stub.

---

## 12. Connection Mode Independence

**Rule:** Each AI feature has its own independent connection config. `librarianConnectionMode` MUST NOT share with retrieval (`aiSearchConnectionMode`).

**Why (user feedback):** The 6 AI feature blocks (AI Search, Scribe, Auto Lorebook, AI Notepad, Librarian, Optimize Keys) are intentionally independent. Don't "helpfully" collapse them. `inherit` mode falls back to `aiSearch` settings (not to each other).

**Where:** `settings.js` — `resolveConnectionConfig(toolKey)` dispatches per-tool. See also `feedback_dle_ai_channels.md` in memory.

---

## 13. Module-Scope for onGenerate Dependencies

**Rule:** Anything that `onGenerate` touches at runtime MUST be module-scope (or imported at module scope), not defined inside `init()`.

**Why (BUG from `bugs_ongenerate_scope.md`):** `_updatePipelineStatus` was originally defined inside `init()` scope. `onGenerate` couldn't see it — every generation crashed silently because ST swallows interceptor errors. The error was invisible until someone checked the console.

**Where:** `index.js` L160-175 (`_updatePipelineStatus` and `_removePipelineStatus` are module-scope functions).

---

## 14. Listener Registration via `_registerEs`

**Rule:** All `eventSource.on/once` registrations in `init()` MUST use `_registerEs()`. Direct `eventSource.on()` calls bypass teardown tracking.

**Why (BUG-063):** `_teardownDleExtension()` iterates `_dleListeners.eventSource` to remove every tracked listener on teardown (page unload, re-init). A listener registered directly with `eventSource.on()` cannot be removed on teardown, causing duplicate handlers on reload and leaked closures.

**Where:** `index.js` L80-89 (`_registerEs` definition), L91-107 (`_teardownDleExtension`), L858-864 (re-init guard). Exception: per-generation listeners wired inside `onGenerate` (e.g. `GENERATION_STOPPED`, `STREAM_TOKEN_RECEIVED`) are torn down in the `finally` block, not via `_registerEs`.

---

## 15. `scribeInProgress` Must NOT Reset on CHAT_CHANGED

**Rule:** Do NOT reset `scribeInProgress` in the CHAT_CHANGED handler. The in-flight scribe owns its own flag and releases it in its own `finally` block.

**Why (BUG-275):** Resetting the flag here races with a scribe that is still mid-`await` on chat A. When the user returns to chat A, a second scribe starts concurrently — two `writeNotes` + two reindexes race, corrupting state.

**Where:** `index.js` L1614-1617 (comment explaining why NOT to reset). `src/ai/scribe.js` L215 (flag released in scribe's own `finally`).

---

## 16. Build Epoch Zombie Guard

**Rule:** Long-running index builds MUST capture `buildEpoch` at start and bail if epoch changes mid-build. Force-releasing a stuck indexing flag bumps `buildEpoch`.

**Why (BUG-015/AUDIT-C05):** Without this, a zombie build (stuck in a slow Obsidian fetch) that unsticks after a force-release will commit a stale index on top of a fresh one, silently reverting vault changes.

**Where:** `src/state.js` L176-179 (`buildEpoch` + setter). `src/vault/vault.js` L259-265 (`buildIndex` capture + zombie helper), L486 (commit guard), L593-596 (`buildIndexWithReuse` capture), L671 (mid-loop check), L776 (final check before commit). `src/vault/sync.js` L94 (force-release bump).

---

## 17. Health Check `entries` → `vaultIndex` Fix

**Rule:** The health check in `src/ui/diagnostics.js` must use `vaultIndex` (the live state binding), not a local `entries` variable.

**Why (BUG FIX):** At ~line 145, the health check was referencing `entries` (undefined in that scope) instead of `vaultIndex` when running exclude-reference validation. This caused the health check to crash on any vault that had entries with `excludes` references, silently swallowing the error and returning incomplete diagnostics.

**Where:** `src/ui/diagnostics.js` ~L145.

---

## 18. `diagnoseEntry()` Pipeline Stage Coverage

**Rule:** `diagnoseEntry()` must check all pipeline stages that can remove an entry, not just matching and budget.

**Why:** Users running `/dle-health` need to know WHY a specific entry wasn't injected. Missing stages cause false "not matched" diagnoses when the entry was actually matched but filtered out by a later stage.

**Additional stages now checked:** `guide_entry` (entry is guide-only, never reaches writing AI), `folder_filter` (filtered by active folder selection), `blocked` (per-chat block override), `contextual_gating` (failed era/location/scene/character/custom field filter), `strip_dedup` (removed by strip dedup — identical injection in recent context).

**Where:** `src/ui/diagnostics.js` `diagnoseEntry()`.

---

## 19. `pseudonymizeTrace()` Must Scrub `matchedBy` and AI `reason`

**Rule:** When pseudonymizing pipeline trace data for diagnostic export, `matchedBy` fields and AI `reason` strings must also be scrubbed.

**Why:** `matchedBy` can contain entry titles and keyword matches that reveal vault content. AI `reason` strings contain the AI's rationale for selecting entries, which can quote vault content or character names. Without scrubbing these, the "anonymized" diagnostic export leaks user content.

**Where:** `src/diagnostics/state-snapshot.js` `pseudonymizeTrace()`.

---

## 20. Scrubber Pattern Callback Argument Counts

**Rule:** Each pattern `fn` in `src/diagnostics/scrubber.js` MUST have parameter count = (1 match + N capture groups + offset + fullString + ctx). The wrapper appends `ctx` after `String.prototype.replace`'s standard args. A phantom parameter shifts `ctx` to a position that never gets filled → `ctx` is `undefined` → `TypeError` → silently caught → pattern does nothing.

**Why (BUG found by test suite):** 7 of 10 scrubber patterns (Bearer tokens, URL tokens, OpenAI keys, IPv4, IPv6, emails, long tokens) had an extra `_gl` phantom parameter, causing `ctx` to always be `undefined`. The outer try/catch swallowed the TypeError. Result: diagnostic exports only scrubbed file paths and hostnames — IPs, emails, API keys, and bearer tokens passed through unredacted.

**Pattern:** For a regex with N capture groups, the fn should have exactly `N + 4` parameters: `(match, ...Ngroups, offset, fullString, ctx)`.

**Where:** `src/diagnostics/scrubber.js` L70-140 (PATTERNS array).
