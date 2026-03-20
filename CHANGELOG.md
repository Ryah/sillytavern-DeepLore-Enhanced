# Changelog

## 0.2.0-BETA

### New Features
- **AI Notebook** — Persistent per-chat scratchpad injected every turn. Edit via `/dle-notebook`. Stored in chat metadata, survives reloads. Configurable injection position/depth/role.
- **Probability Frontmatter** — New `probability` field (0.0-1.0) for entries. When matched, random roll determines if entry fires. Constants always fire.
- **Entry Browser** — `/dle-browse` command opens searchable, filterable popup of all indexed entries with full content preview, analytics, and Obsidian deep links.
- **Entry Relationship Graph** — `/dle-graph` command visualizes requires/excludes/cascade/wiki-link relationships as an interactive force-directed graph on canvas.
- **"Why Not?" Diagnostics** — In Test Match popup, click unmatched entries to see exactly why they didn't fire (keyword miss, scan depth, gating, cooldown, budget, AI rejection) with suggestions.
- **Injection Deduplication** — Opt-in: skip re-injecting entries already in context from recent generations. Tracks injection history per chat via `chat_metadata`.
- **Auto Lorebook Creation** — `/dle-suggest` or auto-trigger: AI analyzes chat for entities not in lorebook, suggests new entries with human gate (editable popup). Writes accepted entries to Obsidian.
- **Optimize Keywords** — `/dle-optimize-keys` sends entries to AI for keyword suggestions. Mode-aware: keyword-only (precise) vs two-stage (broad). Single or batch.
- **Activation Simulation** — `/dle-simulate` replays chat history step-by-step showing which entries activate/deactivate at each message.
- **Enhanced Context Cartographer** — Token bar chart per entry, injection position grouping, expandable content preview, vault attribution for multi-vault. New `/dle-context` for real-time view without generating.
- **Scribe Session Timeline** — `/dle-scribe-history` fetches and displays all session notes from Obsidian. Scribe context now persists across page reloads via chat metadata.
- **Multi-Vault Support** — Connect multiple Obsidian vaults with independent settings. Entries merged with vault attribution shown in Context Cartographer and Entry Browser.
- **Per-Chat Pin/Block** — Pin entries to always inject or block entries from injecting on a per-chat basis. Managed via `/dle-pin`, `/dle-unpin`, `/dle-block`, `/dle-unblock`, `/dle-pins`. Stored in `chat_metadata`.
- **Contextual Gating** — Filter entries by `era`, `location`, `scene_type`, and `character_present` frontmatter fields. Set the active context with `/dle-set-era`, `/dle-set-location`, `/dle-set-scene`, `/dle-set-characters`. View state with `/dle-context-state`.
- **Entry Decay & Freshness** — Tracks how long since each entry was last injected. Stale entries get a boost in the AI manifest; frequently injected entries get a penalty. Configurable thresholds.
- **ST Lorebook Import Bridge** — `/dle-import` converts SillyTavern World Info JSON exports into Obsidian vault notes with proper frontmatter. Handles WI exports, V2 character cards, and entry arrays.
- **Auto-Summary Generation** — `/dle-summarize` generates AI summaries for entries that lack a `summary` field. Writes directly to Obsidian frontmatter.
- **Setup Wizard** — `/dle-setup` walks through first-time configuration: Obsidian connection, AI search, and initial index build.
- **Quick Actions Bar** — Settings panel includes a toolbar of one-click buttons for common operations: Browse, Map, Health, Refresh, Graph, Simulate, Analytics, Optimize, Inspect, Setup.
- **Scribe-Informed Retrieval** — When enabled, feeds the Session Scribe's latest summary into the AI search context for better entry selection.
- **Confidence-Gated Budget** — AI search over-requests entries (2x), then sorts by confidence tier (high → medium → low) before applying the budget cap.
- **Prompt Cache Optimization** — In proxy mode, manifest is placed first with `cache_control` breakpoints to leverage prompt caching on subsequent calls.
- **Circuit Breaker** — Obsidian connection uses a circuit breaker pattern (closed/open/half-open) with exponential backoff (2s-15s) to avoid hammering a down server.
- **Sliding Window AI Cache** — AI search cache tracks manifest and chat hashes separately. When only new chat messages are added (no vault changes), cached results are reused if no new entity names from the vault appear in the new messages.
- **IndexedDB Persistent Cache** — Parsed vault index is saved to IndexedDB for instant hydration on page load. Background validation against Obsidian ensures freshness.
- **Incremental Delta Sync** — On auto-sync, fetches only the file listing first, then downloads content only for new files. Removes deleted entries. Falls back to full rebuild.
- **Hierarchical Manifest Clustering** — For large vaults (40+ entries), groups entries by category and uses a two-call AI approach: first selects relevant categories, then selects entries within those categories. Safety valve prevents over-aggressive filtering.

### New Slash Commands
| Command | Description |
|---------|-------------|
| `/dle-notebook` | Open/edit persistent per-chat AI scratchpad |
| `/dle-browse` | Searchable entry browser with content preview |
| `/dle-graph` | Interactive entry relationship graph |
| `/dle-simulate` | Replay chat showing entry activation timeline |
| `/dle-suggest` | AI suggests new lorebook entries from chat |
| `/dle-optimize-keys` | AI keyword suggestions for entries |
| `/dle-context` | Show what would be injected right now |
| `/dle-scribe-history` | View all session notes from Obsidian |
| `/dle-pin` | Pin an entry to always inject in the current chat |
| `/dle-unpin` | Remove a pin from the current chat |
| `/dle-block` | Block an entry from injecting in the current chat |
| `/dle-unblock` | Remove a block from the current chat |
| `/dle-pins` | Show all pins and blocks for the current chat |
| `/dle-set-era` | Set the active era for contextual gating |
| `/dle-set-location` | Set the active location for contextual gating |
| `/dle-set-scene` | Set the active scene type for contextual gating |
| `/dle-set-characters` | Set the present characters for contextual gating |
| `/dle-context-state` | Show the current contextual gating state |
| `/dle-setup` | Run the first-time setup wizard |
| `/dle-summarize` | Generate AI summaries for entries without one |
| `/dle-import` | Import SillyTavern World Info JSON into the vault |

### New Frontmatter Fields
| Field | Type | Description |
|-------|------|-------------|
| `probability` | number | Chance of triggering when matched (0.0-1.0, null = always) |
| `era` | string | Contextual gating — entry only injects when the active era matches |
| `location` | string | Contextual gating — entry only injects when the active location matches |
| `scene_type` | string | Contextual gating — entry only injects when the active scene type matches |
| `character_present` | string[] | Contextual gating — entry only injects when any listed character is present |

### Settings Overhaul
- **Search Mode dropdown** — Unified "Keyword Only / Two-Stage / AI Only" dropdown replaces separate AI enable checkbox and mode radio buttons
- **AI-Powered Features drawer** — Groups AI Notebook, Session Scribe, and Auto Lorebook into one collapsible section
- **"Show Advanced" toggles** — Power-user settings hidden behind per-section advanced toggles (persisted across sessions) for vault tags, matching, injection, AI search, and index/cache settings
- **"You are Claude Code" toggle** — New checkbox in AI Search advanced settings to control the `You are Claude Code` system prompt prefix (proxy mode only)
- **Vault name deep links** — Removed separate "Obsidian Vault Name" field; vault connection names now serve double duty for Obsidian deep links
- **Title/tooltip audit** — Every setting input now has a descriptive `title` attribute for discoverability
- **Auto-connect on load** — Extension automatically builds the vault index on startup when enabled (3s delay)

### New Settings
- New AI Notebook section: enable, injection position, depth, role
- New `stripDuplicateInjections` and `stripLookbackDepth` in Matching & Budget
- New Auto Lorebook section: enable, interval, connection mode, profile, proxy, model, tokens, timeout, folder
- New `optimizeKeysMode` (keyword-only / two-stage)
- New `vaults` array replacing single-vault connection fields (auto-migrated)
- New Entry Decay section: `decayEnabled`, `decayBoostThreshold`, `decayPenaltyThreshold`
- New `scribeInformedRetrieval` toggle in AI Search

### Self-Healing Diagnostics
- Expanded `/dle-health` from ~7 to 30+ checks: circular requires, duplicate titles, conflicting overrides, orphaned cascade links, AI/Scribe misconfiguration, budget warnings, probability zero, unresolved wiki-links, keyword conflicts, and more.
- Auto-runs on extension load, surfaces warnings via toast (silent if clean).

### Refactor: Module Decomposition
- Decomposed monolithic `index.js` (4619 lines) into 13 focused modules. `index.js` is now ~270 lines (entry point + `onGenerate`).
- New modules: `settings.js`, `src/state.js`, `src/vault.js`, `src/ai.js`, `src/pipeline.js`, `src/sync.js`, `src/scribe.js`, `src/auto-suggest.js`, `src/cartographer.js`, `src/popups.js`, `src/diagnostics.js`, `src/settings-ui.js`, `src/commands.js`.

### Bug Fixes

**Critical:**
- **`clearTimeout(timeoutId)` crashes all AI fallback** — Undefined variable in `aiSearch()` catch block threw `ReferenceError` on every AI error, preventing the `{ results: [], error: true }` return. All documented fallback behavior (two-stage → keywords, ai-only → full vault) was broken. Fixed by removing the stale line.
- **Tracker key mismatch breaks cooldowns, decay, analytics** — `onGenerate()` wrote to cooldown/injection/decay Maps using `trackerKey(entry)` = `"vaultSource:title"`, but 7 reader sites used bare `entry.title`. Keys never matched. Cooldowns never fired, decay never triggered, analytics were wiped on every vault rebuild. Fixed by extracting `trackerKey()` to `state.js` and using it everywhere.
- **CHAT_CHANGED races with in-flight onGenerate** — Added `chatEpoch` counter to `state.js`. Incremented in CHAT_CHANGED handler, captured at start of `onGenerate`, checked before every state write. Bails out if epoch changed mid-pipeline, preventing cross-chat state contamination. Extended to also guard `injection_log` writes and Session Scribe async operations.
- **Cooldown timer freeze** — Early returns in `onGenerate()` skipped `generationCount++` and cooldown decrement, permanently freezing cooldown timers during quiet generations. Fixed with `pipelineRan` flag + `finally` block.
- **Tag setting changes don't invalidate cache** — Changing lorebook/constant/never/seed/bootstrap tags only saved settings without rebuilding the index. Entries retained old tag classification until manual refresh. Now triggers `buildIndex()` on tag change.
- **Stale hydrated data served during background rebuild** — `hydrateFromCache()` set `indexTimestamp` to the cache's original write time, causing `ensureIndexFresh()` to serve stale data if a generation fired before the background rebuild completed. Now sets `indexTimestamp = 0` to force rebuild.
- **Prompt injection via vault content** — Entry summaries were interpolated raw into the AI search manifest. Malicious entries could inject instructions. Now wraps each entry in `<entry>` XML delimiters and escapes special characters in titles.
- **Shared mutable defaults** — `getSettings()` assigned raw object references from `defaultSettings` for `vaults: []` and `analyticsData: {}`, so mutations could corrupt defaults. Now deep-clones non-primitive defaults.
- **Unguarded `finally` block can block SillyTavern generation** — `onGenerate()` finally block contained `cooldownTracker`, `decayTracker`, and `trackerKey()` calls outside try/catch. An exception could propagate through ST's interceptor system and block all generation. Wrapped entire `finally` body in try/catch.
- **Live `vaultIndex` mutated mid-pipeline during async AI search** — Sync polling could replace `vaultIndex` while `onGenerate` was awaiting AI HTTP calls, causing the pipeline to operate on a mix of old and new data. Now captures a snapshot after `ensureIndexFresh()` and passes it through the pipeline.
- **Regex recompilation every generation** — `testEntryMatch()` compiled `new RegExp()` for every keyword of every entry on every generation (4000+ compilations for large vaults). Now caches compiled regexes via WeakMap, invalidated when matching settings change.
- **`buildScanText()` re-allocated per entry** — Entries with custom `scanDepth` each built a fresh concatenated string (~10MB transient allocations for 200 entries). Now memoized by depth within each generation.

**High:**
- **Empty key `""` always matches every message** — Added `if (!key || !key.trim()) continue` guard in `testEntryMatch()` and `countKeywordOccurrences()`.
- **`optimizeEntryKeys()` crashes when called with no arguments** — Settings UI now shows the optimize popup with entry selection instead of calling the function directly.
- **Graph canvas animation loop never stops** — Track `animationFrameId` from `requestAnimationFrame()`. On popup close, `cancelAnimationFrame()` and set `isRunning = false`. Canvas event listeners removed.
- **`showOptimizePopup` corrupts YAML via JSON.stringify** — Replaced `JSON.stringify(val)` with proper YAML value serialization: numbers/booleans unquoted, strings quoted only when containing YAML special chars, arrays as `\n  - item` format.
- **Circuit breaker is a global singleton** — Created `Map<string, CircuitBreaker>` keyed by `host:port`. Factory function `getCircuitBreaker(port)` returns or creates per-vault instance.
- **Setup wizard reads DOM after popup closes** — Input values captured inside the popup's resolution handler before DOM destruction. Stored in closure variables.
- **Import silently overwrites existing vault entries** — Before `writeNote()`, does a GET request to check existence. If file exists, appends `_imported` suffix. Logs skipped/renamed files in import summary toast.
- **Circuit breaker counts HTTP 5xx as success** — Only calls `recordSuccess()` when `response.status < 500`. Calls `recordFailure()` for 5xx.
- **Circuit breaker mishandles auth errors** — Auth errors (401/403) are persistent config issues, not transient server failures. Circuit breaker no longer counts them as failures, giving users immediate feedback on misconfigured API keys instead of unnecessary 2-15s backoff.
- **`Promise.all` in directory listing kills entire index on single failure** — Replaced with `Promise.allSettled()`. Filters for `status === 'fulfilled'`, logs warnings for rejected.
- **AI search cache not invalidated on CHAT_CHANGED** — Cache reset added to CHAT_CHANGED handler.
- **Profile mode never records token usage** — `aiSearchStats` token counters only updated in proxy path. Session stats always zero for profile users. Fixed.
- **`\b` word boundary fails for non-word-char keys** — When key starts/ends with non-`\w` characters, uses `(?<!\w)`/`(?!\w)` lookahead/lookbehind instead of `\b`.
- **Duplicate titles collide on cooldown/analytics/decay Maps** — Uses `entry.vaultSource + ':' + entry.title` as tracker key for all per-entry Maps.
- **`response.json()` without safe parsing** — Proxy response parsing threw opaque `SyntaxError` on non-JSON responses. Now uses `response.text()` + `JSON.parse()` with descriptive error.
- **AI response parser title/name mismatch** — Non-Claude models returning `item.name` instead of `item.title` got selections silently dropped. Now accepts both fields.
- **Entry titles break XML injection template** — Titles with `<`, `>`, `&` corrupted prompt structure. Now XML-escapes titles in injection template.
- **Scribe writes unsanitized AI output** — AI-generated `---` lines could break YAML frontmatter parsing. Now replaced with `- - -`.
- **Notebook/Quick Action buttons ignore disabled state** — Buttons worked when features were off. Added guards.
- **AI search cache not keyed by all settings** — Changing system prompt, scan depth, or max entries served stale cached results. Now includes settings in cache key hash.
- **IndexedDB cache uses single key for all vaults** — Multi-vault: vault A's cache could serve vault B's data. Now keyed by vault configuration fingerprint.
- **Hierarchical pre-filter matching too strict** — Exact category name matching dropped entire categories on AI reformulations. Now uses substring matching.
- **`unlimitedBudget`/`unlimitedEntries` default true** — Zero budget enforcement out of the box. Changed defaults to `false`.
- **Client AI response parser too permissive** — `extractAiResponseClient()` accepted any JSON array without validation. Now checks that array contents are strings or objects with `title`/`name`, matching the server parser's robustness.
- **Greedy regex in `extractAiResponseClient`** — JSON array extraction used greedy `[\s\S]*` instead of lazy `[\s\S]*?`, capturing too much text.
- **Non-greedy regex matches inner arrays in AI responses** — Uses bracket-balanced extraction (bracket counting with string awareness) instead of regex. Tries largest candidates first.
- **Health badge click overwrites user's chat input** — Calls `runHealthCheck()` directly and shows results in a popup instead of injecting `/dle-health` into chat input.
- **No loading state for AI operations** — Shows persistent toast with `timeOut: 0` at start of AI ops, dismissed on completion/error.
- **Concurrent `onGenerate` calls corrupt cooldown state** — Rapid regeneration produced overlapping async executions, doubling cooldown timer expiry speed. Added generation lock.
- **`decayPenaltyThreshold` was never implemented** — Setting was defined, validated, and announced but zero code read it. Now annotates frequently-injected entries as `[FREQUENT]` in the AI manifest, biasing AI away from them.
- **Sliding window cache entity check O(V*N)** — Built a 5000-element Set and ran 5000 substring searches every generation. Now pre-computes entity name Set during `buildIndex()`.
- **Browse popup search allocated ~2MB per keystroke** — Built concatenated search string for every entry on every input event with no debounce. Now pre-computes search haystacks and debounces input (150ms).
- **`/dle-refresh` clears index before rebuild** — `setVaultIndex([])` ran synchronously before async `buildIndex()`, giving zero entries during rebuild window. Removed pre-clear; `buildIndex()` already replaces atomically.
- **`hydrateFromCache` sets `indexEverLoaded` prematurely** — Suppressed "No vault entries loaded" warning when background rebuild failed. Now set only after successful Obsidian fetch.
- **`previousSources` in Cartographer retained full VaultEntry references** — Pinned old vaultIndex in memory after rebuild. Now stores only `{title, tokens}`.
- **PM prompts not registered for new characters** — Prompt Manager entries only added for character active at init. Character switches left new characters without DLE entries. Now re-registers on `CHAT_CHANGED`.
- **`/dle-analytics` browse popup used wrong key format** — Browse popup read `analytics[entry.title]` instead of `analytics[trackerKey(entry)]`. Multi-vault users saw all entries as "never used." Fixed key lookup.
- **`decayTracker` iterated entire vault every generation** — For a 1000-entry vault, 1000 Map operations per generation. Now only tracks entries that have been injected at least once.

**Medium:**
- **Test Match pipeline order** — Simulation ran gating before cooldown, opposite to actual `onGenerate` order. Reordered to match.
- **`/dle-context` missing cooldown filter** — Command showed entries blocked by re-injection cooldown. Now applies cooldown filter before gating.
- **Case-insensitive orphan detection** — Health check used case-sensitive comparison for requires/excludes/cascade_links while `applyGating()` is case-insensitive. Fixed all five instances.
- **Case-insensitive graph edges** — Relationship graph used case-sensitive title lookups. Fixed to match runtime behavior.
- **Case-insensitive wiki-link resolution** — Unresolved wiki-link check in diagnostics was case-sensitive. Fixed.
- **Depth/role override warning** — Health check warned about depth overrides without considering global injection position default. Now checks effective position.
- **Manifest header count wrong in two-stage mode** — `buildCandidateManifest()` reported "from N total" using the full vault count instead of the actual candidate count. AI received a misleading header.
- **`autoSuggestMessageCount` not reset on CHAT_CHANGED** — Reset added to handler.
- **`lastPipelineTrace` not reset on CHAT_CHANGED** — Reset added to handler.
- **`lastInjectionSources` not reset on CHAT_CHANGED** — Reset added to handler.
- **Cartographer `previousSources` not reset on chat change** — First generation showed diff against previous chat's sources. Now reset in CHAT_CHANGED.
- **Warning ratio reset** — `lastWarningRatio` not reset on chat change, causing stale toast suppression.
- **YAML injection in auto-suggest** — AI-generated frontmatter values with special characters produced malformed YAML. Now escapes values.
- **YAML escaping incomplete for auto-suggest entries** — Also escapes `\n` and `\\`. Uses YAML block scalar `|` for multiline summaries.
- **Scribe filename sanitization incomplete** — Now strips leading/trailing dots, trailing spaces, Windows reserved names.
- **Import assumes error = not found** — Network failures treated as "file doesn't exist", leading to overwrites. Now distinguishes error types.
- **Import `_imported` suffix no uniqueness loop** — Second import overwrote `Foo_imported.md`. Now tries `_imported_2`, `_imported_3`, etc.
- **Import position mapping is lossy** — Adds YAML comment to imported entries noting original ST position. Shows summary warning after import.
- **`testConnection()` JSON parse on non-JSON** — Opaque error if port used by another service. Now wrapped in try/catch with descriptive error.
- **IndexedDB quota exhaustion unhandled** — Large vaults silently failed to cache. Now shows warning toast.
- **IndexedDB cache schema drift** — Replaced manual 28-field enumeration with `entries.map(e => { const c = {...e}; delete c._rawContent; return c; })`. Added `CACHE_SCHEMA_VERSION` to stored data, returns null on mismatch.
- **Cache TTL=0 semantics aligned** — TTL=0 now means "always fetch fresh" (rebuild every generation), matching tooltip. Previous code cached indefinitely when TTL=0.
- **No settings snapshot during async pipeline** — Settings changes during AI search affected mid-pipeline. `runPipeline()` now takes a shallow snapshot.
- **Settings version tracking** — Added `settingsVersion` to `defaultSettings`. `getSettings()` checks stored version, runs migration functions if different.
- **Sync polling setInterval can stack** — Replaced `setInterval` with `setTimeout` chaining (next scheduled after current completes).
- **3-second delayed init races with early generation** — Checks `indexEverLoaded` or `indexing` before hydrating. Skips if build already started.
- **Number inputs accept out-of-range values visually** — Now clamps displayed value to match constraint range.
- **Browse popup re-registers event listeners on every keystroke** — Replaced with event delegation on container element.
- **Notebook popup reads textarea after popup closes** — Textarea value captured in closure variable before popup resolves.
- **Usage statistics always zero in profile mode** — Displays "N/A" in UI when usage data unavailable from `sendRequest`.
- **Scribe disabled state sets `disabled` on div elements** — Added CSS `.menu_button.disabled { opacity: 0.4; pointer-events: none; }` to `style.css`.
- **Manifest summary XML injection** — Summary text inside `<entry>` tags wasn't XML-escaped. Summaries containing `</entry>` could break manifest structure. Now `escapeXml()`'d.
- **Numeric `summary:` values silently lost** — YAML `summary: 42` parsed as number, failed `typeof === 'string'` check. Now coerces with `String()`.
- **Refine keys use plain `\b` word boundary** — Broke for keys like `#ritual` or `C++`. Refine keys now use same smart `(?<!\w)`/`(?!\w)` boundary logic as primary keys.
- **`injection_log.flatMap` crashes on corrupted metadata** — Older chat metadata could lack `.entries` on log entries. Added `l.entries || []` guard.
- **Scribe YAML injection via character name** — Character names with YAML special chars corrupted frontmatter. Now YAML double-quoted with escape.
- **Sync polling ignores changed interval setting** — Changing sync polling interval in settings had no effect until page reload. Now re-reads interval each tick.
- **Partial vault fetch not surfaced to user** — When 5+ files or >10% fail to fetch, now shows a warning toast instead of only logging to console.
- **Scribe not epoch-guarded** — Session Scribe runs on CHARACTER_MESSAGE_RENDERED without chatEpoch guard. Async AI call + Obsidian write could write to wrong chat's metadata. Added epoch guard.

**Low:**
- **Server `||` on timeout/maxTokens** — `timeout || 15000` and `maxTokens || 1024` treated explicit `0` as falsy. Changed to `??` (nullish coalescing).
- **`Number || default` falsy-zero** — `Number(val) || default` treated valid 0 as falsy. Fixed with `isNaN()` checks.
- **Directory recursion off-by-one** — `listAllFiles()` allowed 21 nesting levels instead of 20. Fixed `> 20` to `>= 20`.
- **`generateQuietPrompt` API** — Wrong API call signature for quiet generation.
- **Scribe-notes HTTP status** — Missing HTTP status check on scribe-notes fetch.
- **Auto-suggest scan depth** — Incorrect scan depth used for auto-suggest AI context.
- **Backslash link false positives** — `extractWikiLinks()` now strips trailing backslashes from pipe-alias wiki-links (`[[Name\|Display]]` → `Name` not `Name\`)
- **Cascade link false positives** — Health check now matches cascade links against filenames too, not just entry titles
- **Self-exclude detection** — Health check warns when an entry's `excludes` list contains itself
- **Browse popup badge alignment** — `[constant] [seed] [bootstrap]` badges now left-aligned with title instead of floating right
- **First entry budget bypass undocumented** — `formatAndGroup()` always accepts the first entry even if it exceeds the token budget (by design, to avoid empty results). Added a debug-mode warning when this happens.
- **Dead AbortController in `aiSearch()`** — Removed the outer AbortController and setTimeout. Inner calls handle their own timeouts.
- **Analytics data pruning missing from delta sync** — Copied analytics pruning block from `buildIndex()` into `buildIndexDelta()` after `setVaultIndex`.
- **Analytics pruning key mismatch** — Analytics were written with `trackerKey` keys but pruned with bare titles, causing all analytics to be wiped on every vault rebuild. Fixed to use `trackerKey` consistently.
- **Vault name containing `:` breaks delta sync key** — Uses `\0` as separator instead of `:` in existingMap keys.
- **`__proto__`/`constructor` title pollutes analytics object** — Uses `Object.create(null)` for analytics and guards with `Object.hasOwn()` checks.
- **No profile existence validation before API call** — Calls `getProfile(profileId)` first, throws descriptive error if null.
- **Scribe filename minute-level precision collisions** — Added seconds to filename format: `HH-MM-SS`.
- **Short keys bypass AI cache entity detection** — Lowered key threshold to 3 (matching title threshold).
- **`fetchMdFilesDelta()` is dead code** — Removed the function.
- **1-2 char entity names never bust AI cache** — Short titles like "Vi" were filtered out. Now allows titles >= 1 char.
- **simpleHash 32-bit collision risk** — Upgraded to double-hash (two independent DJB2 passes) producing 64+ effective bits.
- **Proxy connection test costs real tokens** — Reduced prompt to `"ping"` and max_tokens to 8.
- **Dead `obsidianVaultName` setting** — Removed unused setting from defaults.
- **`parseWorldInfoJson` throws raw SyntaxError** — Now wraps in user-friendly error message.
- **`#dle_refresh` has no success toast** — Now shows success toast like `#dle_qa_refresh`.
- **Blocks override constant entries** — Documented as intentional: blocks are manual overrides for constants.

- **Import dedup loop has no upper bound** — Added `MAX_DEDUP_ATTEMPTS = 20` safety cap to the filename uniqueness loop.
- **Import can produce filenames of only underscores** — Added fallback to `"Untitled"` when sanitized name is empty.
- **Graph force layout O(n^2) per frame** — Added warning toast for vaults > 200 entries to alert users of potential slowness.
- **Scribe filename edge case with dot-only character names** — Added fallback to `"Unknown"` if charName is empty after sanitization.
- **Import 404 message parsing is unreachable dead code** — Removed the dead `includes('404')` check in catch block (`obsidianFetch` returns status codes, doesn't throw for 404).

*(Deferred)* Magic number imports, YAML parser docs, inline styles → CSS, ARIA labels — documented in plan for future work.

### Internal
- New `probability`, `vaultSource`, `era`, `location`, `sceneType`, `characterPresent` fields on VaultEntry
- New modules: `src/cache.js` (IndexedDB persistent cache), `src/import.js` (WI import bridge)
- New server endpoint `POST /scribe-notes` for session timeline
- `chat_metadata` now stores: `deeplore_notebook`, `deeplore_lastScribeSummary`, `deeplore_injection_log`, `deeplore_pins`, `deeplore_blocks`, `deeplore_context`
- `matchEntries()` now returns `probabilitySkipped` array
- `onGenerate()` uses `pipelineRan` flag + `finally` block for generation tracking
- `aiSearchCache` shape: `{hash, manifestHash, chatLineCount, results}` for sliding window cache
- New state: `decayTracker`, `lastHealthResult`
- Init hydrates from IndexedDB cache, falls back to full Obsidian fetch
- Delta sync fetches file listing first, downloads only new files
- 210 passing tests
- Bumped version to 0.2.0-BETA

## 0.14-ALPHA

### Session Scribe Overhaul
- **Connection Manager Support** -- Session Scribe can now use saved Connection Manager profiles or a custom proxy, independent from your main AI connection. Three modes: SillyTavern (default, uses active connection), Connection Profile, or Custom Proxy.
- **Chat Position Tracking** -- Auto-scribe now tracks actual chat position (`chat.length`) instead of an internal counter. More reliable across swipes and edge cases.
- **Prior Note Context** -- Each summary receives the previous session note as context, so the AI builds on prior summaries instead of repeating content.
- **Better Default Prompt** -- New default prompt produces richer summaries: covers events, character dynamics, revelations, and state changes in past tense with specific details.
- **Configurable Message Window** -- New "Messages to Include" setting (default: 20, range: 5-100) replaces the hardcoded 20-message limit.
- **Higher Token Limit** -- Default max response tokens increased from 512 to 1024, configurable up to 4096.

### Settings
- New "Connection" radio in Session Scribe: "SillyTavern" (default), "Connection Profile", or "Custom Proxy"
- New "Connection Profile" dropdown for Scribe (independent from AI Search profile)
- New "Proxy URL", "Model Override", "Max Response Tokens", "Timeout" fields for Scribe
- New "Messages to Include" field (replaces hardcoded 20-message context window)
- Model/tokens/timeout fields hidden in SillyTavern mode for cleaner UI

### Internal
- Refactored `callViaProfile()` to accept optional `profileId` and `modelOverride` params (shared by AI Search and Scribe)
- New `callScribe()` routing function for connection mode dispatch
- New `populateScribeProfileDropdown()` and `updateScribeConnectionVisibility()` UI helpers
- New server endpoint `POST /scribe` for proxy mode summary generation
- `runScribe()` now uses `buildAiChatContext()` from `core/utils.js` for consistent message formatting
- Scribe profile dropdown auto-refreshes on Connection Manager profile events
- Bumped version to 0.14-ALPHA

## 0.13-ALPHA

### New Features
- **Connection Profile Support** -- AI search can now use saved SillyTavern Connection Manager profiles instead of requiring a separate proxy server. Select any saved profile from a dropdown in AI Search settings. All API providers supported by Connection Manager work (Anthropic, OpenAI, OpenRouter, etc.). Custom proxy mode preserved as a toggle for claude-code-proxy users.
- **Model Override** -- AI search model field is now an optional override. In profile mode, it defaults to the profile's model. In proxy mode, it defaults to claude-haiku-4-5.

### Settings
- New "Connection" radio: "Connection Profile" (default) or "Custom Proxy" in AI Search section.
- New "Connection Profile" dropdown to select a saved Connection Manager profile.
- "Model" field renamed to "Model Override" — leave empty to auto-use profile/default model.

### Internal
- New import: `ConnectionManagerRequestService` from ST's `shared.js`
- New functions: `callViaProfile()`, `extractAiResponseClient()`, `getProfileModelHint()`, `populateProfileDropdown()`, `updateAiConnectionVisibility()`
- `aiSearch()` now routes through either `callViaProfile()` (profile mode) or server proxy (proxy mode)
- Profile dropdown auto-refreshes on Connection Manager profile events
- Bumped version to 0.13-ALPHA

## 0.12-ALPHA

### New Features
- **Active Character Boost** -- New `characterContextScan` setting. When enabled, automatically matches the active character's vault entry by name or keyword, ensuring their lore is available whenever they're in the conversation.
- **Pipeline Inspector** -- New `/dle-inspect` slash command. Shows a detailed trace of the last generation pipeline: keyword-matched entries with trigger keywords, AI-selected entries with confidence and reasons, fallback status, and pipeline mode.

### Internal
- 158 passing tests
- Bumped version to 0.12-ALPHA

## 0.11-ALPHA

### Refactor: Shared Core Extraction
- **Shared `core/` directory** -- Extracted ~800 lines of duplicated functions into 4 shared ES module files (`core/utils.js`, `core/matching.js`, `core/pipeline.js`, `core/sync.js`). Both DeepLore and DeepLore Enhanced now import from these shared modules instead of maintaining inline copies.
- **Shared `server/core/obsidian.js`** -- Extracted Obsidian REST API helpers (obsidianRequest, encodeVaultPath, listAllFiles) into a shared CommonJS module.
- **Parameterized functions** -- Functions that previously referenced module-level constants now accept them as arguments: `validateSettings(settings, constraints)`, `formatAndGroup(entries, settings, promptTagPrefix)`, `resolveLinks(vaultIndex)`, `takeIndexSnapshot(vaultIndex)`, `clearPrompts(extensionPrompts, promptTagPrefix, promptTag)`.
- **New `parseVaultFile()`** -- Replaces the ~80-line inline parsing loop in `buildIndex()` with a single shared function. Builds the full VaultEntry structure including seed/bootstrap/summary fields (base DeepLore ignores these).
- **Tests migrated to ESM** -- `tests.js` replaced by `tests.mjs` importing from `./core/` instead of duplicating functions. Enhanced: 158 tests, Base: 130 tests.
- **Sync tooling** -- New `sync-commit.ps1` script in parent directory validates core/ parity, runs tests in both repos, and commits+pushes with the same message.
- **No behavior changes** -- Pure refactor. All existing functionality preserved.

### Internal
- New shared files: `core/utils.js`, `core/matching.js`, `core/pipeline.js`, `core/sync.js`, `core/README.md`, `server/core/obsidian.js`
- Sync workflow documented in `core/README.md`
- 158 passing tests
- Bumped version to 0.11-ALPHA

## 0.10-ALPHA

### New Features
- **Cooldown Tags** -- Per-entry `cooldown: N` frontmatter field. After an entry triggers, it's skipped for the next N generations before becoming eligible again.
- **Warmup Tags** -- Per-entry `warmup: N` frontmatter field. An entry's keywords must appear N or more times in the scan text before it triggers for the first time.
- **Re-injection Cooldown** -- New global setting to skip re-injecting an entry for N generations after it was last injected. Helps save context by avoiding redundant lore repetition. Constants are exempt.
- **Entry Usage Analytics** -- Tracks how often each entry is matched and injected across generations. View with `/dle-analytics`. Shows a table sorted by injection count plus a "Never Injected" section for dead entry detection.
- **Entry Health Check** -- `/dle-health` audits all vault entries for common issues: empty keys on non-constant entries, orphaned requires/excludes references, oversized entries (>1500 tokens), duplicate keywords shared across entries, and missing AI selection summaries.

### Bug Fixes
- **Gating null guards** -- `applyGating()` now checks `entry.requires && entry.requires.length` before iterating, preventing errors on entries with undefined gating fields.

### Settings
- New "Re-injection Cooldown" setting in Matching section (0 = disabled, N = skip for N generations).

### New Frontmatter Fields
| Field | Type | Description |
|-------|------|-------------|
| `cooldown` | number | Generations to skip after triggering |
| `warmup` | number | Keyword occurrence count required before first trigger |

### New Slash Commands
| Command | Description |
|---------|-------------|
| `/dle-analytics` | Show entry usage analytics popup |
| `/dle-health` | Audit entries for common issues |

### Internal
- New function: `countKeywordOccurrences()`
- New globals: `cooldownTracker`, `generationCount`, `injectionHistory`
- Session state (cooldownTracker, injectionHistory, generationCount) resets on CHAT_CHANGED
- Analytics data persisted in `settings.analyticsData` via SillyTavern settings save
- 136 passing tests
- Bumped version to 0.10-ALPHA

## 0.94-ALPHA

### Manifest Format Optimization
- **Compressed manifest format** -- Manifest entries sent to Haiku now use a compact format: `EntryName (Ntok) → LinkedEntries` followed by the summary text. Removed redundant Keys, Tags, and labels. ~30% token reduction per manifest.
- **Increased default summary length** -- Default summary length increased from 400 to 600 characters, capturing more of each entry's structured meta-block data (Triggers, Related, Who Knows, etc.) that helps Haiku make better selections.
- **Updated AI system prompt** -- System prompt now describes the new manifest format, including how to interpret `→` links and `[bracketed]` metadata fields like Triggers and Related.
- **Summary length max increased** -- Settings slider now allows up to 1000 characters (was 800).
- **Summary frontmatter field** -- Entries can now include a `summary:` field in frontmatter, written specifically for AI selection. The manifest uses this instead of truncating entry content. Entries without a summary fall back to content truncation.

## 0.93-ALPHA

### Pipeline Overhaul: Two-Stage Keyword → AI Selection
- **Sequential pre-filter pipeline** -- Keywords now run first as a broad pre-filter (Stage 1), then only keyword-matched candidates are sent to Haiku for smart selection (Stage 2). Previously both ran in parallel with the full vault manifest sent to AI.
- **AI Search Mode setting** -- New radio toggle: "Two-Stage (keywords → AI)" for the pre-filter pipeline, or "AI Only (full vault)" for sending the entire manifest to Haiku directly. Replaces the old scanDepth=0 workaround.
- **Error-aware AI fallback** -- AI search now distinguishes errors from intentional empty results. On error, falls back to keyword results (two-stage) or full vault (ai-only). On intentional empty, keeps constants only.
- **{{maxEntries}} in system prompt** -- AI system prompt now includes the configured max entries limit so Haiku knows how many to select.
- **Removed merge step** -- `mergeResults()` deleted. AI output IS the final selection (plus constants). No more confidence-based priority offset merging.

### Settings
- New "AI Search Mode" radio (Two-Stage / AI Only) in AI Search section.
- Removed "AI Priority Offset" setting (no longer applicable without merge).

### Internal
- New function: `buildCandidateManifest()` -- builds manifest from filtered entries
- Deleted: `mergeResults()`, `buildManifest()`, `cachedManifest`/`cachedManifestHeader` globals
- `aiSearch()` signature changed: accepts candidate manifest/header, returns `{results, error}`
- `onGenerate()` rewritten for sequential pipeline with three modes
- Test Match and Preview AI Prompt handlers updated for new pipeline
- Bumped version to 0.93-ALPHA

## 0.9-ALPHA

### New Features
- **Conditional Gating (requires/excludes)** -- Entries can now declare dependencies on other entries. `requires: [Eris, Dark Council]` means ALL listed entries must be matched for this entry to inject. `excludes: [Draft Notes]` blocks this entry if ANY listed entry is matched. Gating resolves iteratively, so cascading dependencies work correctly.
- **Per-Entry Injection Position** -- Entries can override the global injection position via frontmatter: `position` (before/after/in_chat), `depth` (injection depth for in_chat), and `role` (system/user/assistant). Entries are grouped by their effective position and each group is injected separately. Entries without overrides use the global settings.
- **Vault Change Detection** -- When the index rebuilds, DeepLore now compares the new index against the previous one and reports what changed: new entries, removed entries, modified content, and changed keywords. Optional toast notifications summarize changes.
- **Auto-Sync Polling** -- New setting to automatically rebuild the index on a configurable interval (0-3600 seconds, 0 = disabled). Detects vault changes without manual refresh.

### Settings
- New "Sync Polling Interval" setting in Index & Debug section (seconds between auto-refresh, 0 to disable).
- New "Show Sync Toasts" toggle in Index & Debug section.
- Note added to Injection section about per-entry frontmatter overrides.

### New Frontmatter Fields
| Field | Type | Description |
|-------|------|-------------|
| `requires` | string[] | Entry titles that must all be matched for this entry to activate |
| `excludes` | string[] | Entry titles that, if any matched, block this entry |
| `position` | string | Injection position: `before`, `after`, or `in_chat` |
| `depth` | number | Injection depth (for `in_chat` position) |
| `role` | string | Message role: `system`, `user`, or `assistant` |

### Internal
- New functions: `applyGating()`, `clearDeeplorePrompts()`, `formatAndGroup()`, `takeIndexSnapshot()`, `detectChanges()`, `showChangesToast()`, `setupSyncPolling()`
- `formatWithBudget()` replaced by `formatAndGroup()` which returns grouped prompt data
- Pipeline now: clearPrompts → match → merge → gate → formatAndGroup → inject per group
- Added `extension_prompts` import for multi-key prompt management
- 20 new unit tests covering gating, grouping, and change detection
- Bumped version to 0.9-ALPHA

## 0.82-ALPHA

### Bugfix: AI-only mode actually works now
- **Fixed early return killing AI search** -- When keyword scan depth was set to 0, `onGenerate()` returned early before AI search could run. Removed the empty-scan-text guard so both pipelines always execute.
- **Fixed `slice(-0)` returning all messages** -- `buildScanText(chat, 0)` was evaluating `chat.slice(-0)` which returns the entire array in JavaScript. Added explicit `depth <= 0` guard to `buildScanText()` and `buildAiChatContext()` to properly return empty string.
- **Fixed per-entry scanDepth and recursion bypassing keywords-off** -- When global scan depth was 0, entries with their own `scanDepth` frontmatter still ran keyword matching, and recursive scanning still matched keywords against constant entry content. Restructured `matchEntries()` so the entire keyword matching block (initial scan + per-entry overrides + recursion) is skipped when `scanDepth` is 0. Only constants pass through.
- **Fixed `|| default` clobbering valid 0 values** -- The scan depth input handler used `Number(val) || 4`, which silently replaced 0 with 4 because 0 is falsy in JavaScript. Same issue fixed for injection depth and cache TTL. All three now use `isNaN()` checks instead.
- Bumped version to 0.82-ALPHA.

## 0.81-ALPHA

### AI Search Pipeline Overhaul
- **Richer manifest entries** -- Each entry now includes tags, wiki-link cross-references ("Links to:"), token cost, and longer summaries (400 chars, configurable up to 800). Gives the AI dramatically more context per entry.
- **Wiki-link relationship extraction** -- Links between entries (`[[Eris]]`, `[[Dark Council|the council]]`) are now extracted before content cleaning and resolved to confirmed entry titles. Included in the manifest as "Links to:" lines.
- **Structured AI responses** -- AI now returns confidence levels (high/medium/low) and reasons for each pick instead of a flat title list. Context Cartographer popup shows these reasons directly.
- **Confidence-based priority** -- High-confidence AI picks get no priority penalty (same as keyword matches), medium gets 1x offset, low gets 2x offset. Naturally pushes uncertain picks below certain ones.
- **Annotated chat context** -- Messages sent to the AI now include `(user)` / `(character)` role annotations to clarify who said what.
- **Improved system prompt** -- Ranked selection criteria, mentions relationships and token costs, asks for structured output with reasons.
- **Manifest header** -- AI receives entry count and budget context alongside the manifest.
- **Configurable summary length** -- New "Manifest Summary Length" setting (100-800 chars) in AI Search section.
- **Backward compatible** -- Legacy flat array responses still work. Old server responses with `titles` field handled gracefully alongside new `results` field.
- **AI-only mode** -- Keyword scan depth can now be set to 0 to disable keyword matching entirely, running only AI search (plus constants). The two scan depths are fully independent.

### Internal
- New functions: `extractWikiLinks()`, `resolveLinks()`, `buildAiChatContext()`
- VaultEntry now carries `links`, `resolvedLinks`, and `tags` fields
- Server: `extractJsonArray` replaced with `extractAiResponse` + `normalizeResults` supporting both formats
- Bumped version to 0.81-ALPHA

## 0.8-ALPHA

### New Features
- **Context Cartographer** -- Adds a book icon button to each AI message's action bar. Click it to see which vault entries were injected, why they matched, their priority, and token cost. Configurable Obsidian vault name enables clickable deep links that open entries directly in Obsidian.
- **Session Scribe** -- Automatically summarizes roleplay sessions and writes them to your Obsidian vault as timestamped markdown notes with frontmatter. Triggers after every N AI messages (configurable). Also available on demand via `/dle-scribe`, with optional focus topics.
- **`/dle-scribe` slash command** -- Write a session summary on demand. Optionally provide a focus topic, e.g. `/dle-scribe What happened with the sword?`
- **Obsidian write support** -- New server plugin route (`POST /write-note`) enables writing markdown notes back to the vault.

### Settings
- New "Obsidian Vault Name" field in Connection settings for deep links.
- New "Show Lore Sources Button" toggle in Injection settings.
- New "Session Scribe" settings section: enable toggle, auto-scribe interval, session folder, custom summary prompt.

### Internal
- Lore source data persisted in `message.extra.deeplore_sources` for per-message tracking across sessions.
- Bumped version to 0.8-ALPHA.

## 0.7-ALPHA

### Improvements
- **Accurate token counting** -- Uses SillyTavern's built-in tokenizer instead of the rough `length / 3.5` estimate. Token budgets and stats are now much more accurate. Falls back to estimation if the tokenizer is unavailable.
- **Better recursive scanning** -- Recursive matching now only scans content from newly matched entries each step, avoiding redundant work and preventing wasted cycles when entries reference each other.
- **Sentence-aware manifest truncation** -- AI search manifest summaries now cut at sentence boundaries instead of mid-word, giving the AI better context for entry selection.
- **Runtime settings validation** -- All numeric settings (including AI search settings) are clamped to valid ranges on load and save. Invalid values are corrected automatically.
- **Added package.json** -- Provides version tracking and repository metadata.
- **Added unit tests** -- Test coverage for frontmatter parsing, content cleaning, title extraction, keyword matching, sentence truncation, hash function, and settings validation. Run with `node tests.js`.

### Internal
- Bumped version to 0.7-ALPHA.

## 0.6-ALPHA

- Initial public release.
- Keyword-triggered lorebook injection from Obsidian vault.
- AI-powered semantic search via Claude Haiku.
- Recursive scanning, token budgets, configurable injection.
- Server installer scripts.
