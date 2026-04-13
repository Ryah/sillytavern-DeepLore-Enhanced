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

**Rule:** When `lastMsg.extra.tool_invocations` exists or `lastMsg.is_system`, skip the pipeline entirely.

**Why:** Other extensions may use ST's ToolManager. ST re-calls Generate after each tool invocation. Lore from the original generation is still in context. Re-running the pipeline wastes tokens. DLE's own Librarian uses the agentic loop (not ToolManager), so DLE tool calls never trigger this guard.

**Where:** `index.js` L215-222.

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

## 8. No DLE Intermediate Messages

**Rule:** The agentic loop produces NO intermediate messages in `chat[]`. It runs its own multi-turn conversation internally, then inserts a single clean message via `addOneMessage()`.

**Why (historical):** The old ToolManager approach created `tool_invocation` system messages and intermediate assistant messages that needed post-hoc stripping. The agentic loop eliminates this entire class of bugs — no `stripDleSystemMessages`, no `_cleanupOrphanedDleIntermediates`, no GENERATION_ENDED consolidation.

**Where:** `index.js` L822-844 (single `addOneMessage` call after loop completes).

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

---

## 21. Agentic Loop Epoch Guards

**Rule:** The agentic loop MUST check `epoch !== chatEpoch || lockEpoch !== generationLockEpoch` at the TOP of every iteration, before any API call or state mutation. Also check `signal.aborted`.

**Why:** The agentic loop runs multiple iterations (up to 15) with awaits between each. A chat switch or stop-button press during any iteration must bail the loop immediately. Without this, a stale loop writes tool results and creates messages in the wrong chat.

**Where:** `src/librarian/agentic-loop.js` L123-132 (epoch + abort check at iteration start).

---

## 22. Agentic Loop Stale-Lock Keepalive (C9)

**Rule:** Call `setGenerationLockTimestamp(Date.now())` before every `callWithTools()` call and before tool processing in the agentic loop.

**Why:** The generation lock has a 30s stale detection (`lockAge > 30_000` in onGenerate L233). The agentic loop can run for much longer than 30s (multiple search + API round trips). Without keepalive, the stale-lock detector force-releases the lock mid-loop, bumping `generationLockEpoch`. The loop's next epoch check sees a mismatch and bails, silently dropping the generation.

**Where:** `src/librarian/agentic-loop.js` L157 (before API call), L187 (before tool processing). `src/state.js` L208 (`setGenerationLockTimestamp` — updates timestamp without toggling the lock).

---

## 23. Agentic Loop Re-Entrancy Guard (C1)

**Rule:** After `abort()`, immediately call `setSendButtonState(true)` + `deactivateSendButtons()`. Restore in `finally`.

**Why:** `abort()` calls ST's `unblockGeneration()`, which re-enables the send button. Without the guard, the user can trigger a new generation while the agentic loop is still running, causing race conditions with `chat.push` and `addOneMessage`.

**Where:** `index.js` L783-785 (lock), L858-860 (restore in finally).

---

## 24. Tool Result Batching (C4)

**Rule:** When building tool result messages for the agentic loop, ALL tool results from one assistant turn MUST be batched into the format the provider expects. Claude requires all `tool_result` blocks in a single `user` message. OpenAI/Cohere uses separate `tool` role messages.

**Why:** Claude returns an API error if tool results arrive as separate messages. Google expects `functionResponse` parts in a single `function` role message. Sending results in the wrong format causes a 400 error and breaks the loop.

**Where:** `src/librarian/agentic-api.js` `buildToolResults()` — handles all 4 provider formats.

---

## 25. Provider Format Handling

**Rule:** The agentic loop must preserve provider-native message format for multi-turn conversations. `buildAssistantMessage()` returns the raw response structure (not normalized), and `buildToolResults()` uses the provider-specific format.

**Why:** CMRS passes messages through to the provider API. If DLE normalizes assistant messages to OpenAI format but the provider is Claude, the next API call fails because Claude doesn't understand `tool_calls` in the OpenAI format — it expects `content[]` with `tool_use` blocks. Each provider has its own wire format for tool-calling conversations.

**Where:** `src/librarian/agentic-api.js` — `buildAssistantMessage()`, `buildToolResults()`, `parseToolCalls()`, `getTextContent()` all handle 4 formats (Claude, Google, OpenAI-compatible, Cohere).

---

## 26. `onGenerate` Parameter Must Not Shadow Global `chat`

**Rule:** The `onGenerate` parameter is named `chatMessages` (NOT `chat`). It is a filtered copy (`coreChat`) from ST's interceptor — pushing to it loses data. Always use the global `chat` import from `script.js` for message creation and index lookups.

**Why:** The parameter was previously named `chat`, which shadowed the global `chat` array imported from `script.js`. Code that called `chat.push(msg)` inside `onGenerate` was pushing onto the filtered copy instead of the real chat array, silently losing messages.

**Where:** `index.js` `onGenerate(chatMessages, ...)`.

---

## 27. `saveReply` Does NOT Save to Disk

**Rule:** After calling `saveReply({ type, getMessage })`, you MUST call `saveChatConditional()` to persist the message to disk.

**Why:** `saveReply` handles the message lifecycle (creating the message object, emitting events like `MESSAGE_RECEIVED` and `CHARACTER_MESSAGE_RENDERED`), but it does NOT write to disk. In the agentic loop, `abort()` prevents ST's post-generation save from running, so the message would be lost on reload without an explicit `saveChatConditional()` call.

**Where:** `index.js` agentic loop dispatch (Phase 8b).

---

## 28. `CHARACTER_MESSAGE_RENDERED` Modifies `message.mes` During `saveReply`

**Rule:** The `CHARACTER_MESSAGE_RENDERED` handler extracts AI notes from `message.mes` (cleaning the displayed text). This means `swipes[0]` captures the cleaned text, not the raw AI output. This is intentional — the raw text with notes is not what users see.

**Why:** `saveReply` emits `CHARACTER_MESSAGE_RENDERED` as part of its event chain. DLE's handler strips `<dle-notes>` tags from the message during this emission. If you read `message.mes` after `saveReply`, it will already be cleaned.

**Where:** `index.js` `CHARACTER_MESSAGE_RENDERED` handler, agentic loop dispatch.

---

## 29. `type` Must Be Forwarded to `saveReply`

**Rule:** The `type` parameter from `onGenerate(chatMessages, contextSize, abort, type)` must be forwarded to `saveReply({ type })` for correct swipe and regen behavior.

**Why:** `saveReply` uses `type` to determine whether to create a new message or update an existing swipe. Without forwarding, regens and swipes create duplicate messages instead of replacing the current swipe.

**Guard:** `type !== 'continue' && type !== 'append' && type !== 'appendFinal'` — these types fall through to ST's generation (DLE does not handle continuation types in the agentic loop).

**Where:** `index.js` agentic loop dispatch (Phase 8b).

---

## 30. `onProse` in the Agentic Loop Is Async

**Rule:** `onProse` in the agentic loop is async and MUST be awaited: `await onProse?.(prose)`.

**Why:** `onProse` now calls `saveReply` + `saveChatConditional`, which are async operations. If not awaited, the FLAG phase starts before the message is fully created, events are processed, and data is saved to disk. This can cause race conditions where FLAG tool calls reference a message that doesn't exist yet.

**Where:** `src/librarian/agentic-loop.js` (write tool handler → FLAG phase transition).
