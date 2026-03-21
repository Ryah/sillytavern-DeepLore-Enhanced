# Changelog

## 0.2.1-BETA — Pre-Release Bug Audit

8-expert parallel audit (UI/UX ×2, Race Conditions, Performance, Security, Data Integrity, Chaos Engineering, Parsers/Compilers). 99 raw bugs found, 73 unique after dedup, 44 fixed.

### Bug Fixes

**Critical/High (15 fixed):**
- **Generation lock hangs indefinitely** — `ensureIndexFresh` could block for minutes with a flaky Obsidian. Added 60s timeout; proceeds with stale data if available. (`index.js`)
- **Stale generation lock with no recovery** — Lock had no timeout. Added 120s staleness detection with auto-release. Added `/dle-refresh` hint to toast. (`index.js`, `state.js`)
- **`_pinned` flag leaks permanently** — Setting `entry._pinned = true` directly on shared VaultEntry objects caused pinned entries cut by budget/gating to bypass contextual gating, re-injection cooldown, and dedup on ALL subsequent generations. Replaced with local `pinnedTitles` Set. (`index.js`)
- **`matchEntries()` reads global vaultIndex** — Keyword matching used the live global while AI search used the snapshot, causing entry mismatches during concurrent index rebuilds. Added `snapshot` parameter. (`src/pipeline.js`)
- **Health check on hot path O(n²)** — `runHealthCheck()` with its O(n²) circular-requires check ran synchronously in `buildIndex()`. Deferred via `setTimeout(0)`. Also surfaces errors as toast. (`src/vault.js`)
- **SSRF via proxy URL** — Blocklist only covered 3 IPs. Added IPv6 variants, localhost, RFC 1918/6598/link-local ranges, CGNAT, ULA, numeric IP shorthands. (`src/proxy-api.js`)
- **Multi-vault partial failure persists to cache** — If one vault fails in multi-vault, the incomplete index was persisted to IndexedDB. Now skips cache save on failure. (`src/vault.js`)
- **Entity name min length mismatch** — `buildIndex` used `>= 2`, `buildIndexDelta` used `>= 3`. Two-char keys like "AI" silently dropped from sliding window cache after delta sync. Fixed to `>= 2` in both. (`src/vault.js`)
- **Cache validation misses critical fields** — `validateCachedEntry` didn't check `priority`, `constant`, `requires`, `excludes`, or `probability`. Missing `priority` caused `NaN` in sort comparator. Now defaults missing fields. (`src/cache.js`)
- **TDZ crash in Analytics handler** — `const settings = getSettings()` shadowed the outer `settings` before it was initialized, throwing `ReferenceError` on every Analytics button click. (`src/settings-ui.js`)
- **`escapeXml` missing `"` in AI manifest** — Titles with quotes like `The "Bloodchain" Protocol` produced malformed XML attributes. Added `&quot;` escaping. (`src/ai.js`)
- **Template `{{content}}` breaks XML envelope** — Content containing `</EntryTitle>` could break out of the entry's XML wrapper. Now escapes closing tags when template uses XML wrappers. (`core/matching.js`)
- **`%%` regex eats prose** — `%%[\s\S]*?%%` matched across `100%%` and `50%%` in prose, deleting text between them. Split into inline (same-line) and block (line-boundary) passes. (`core/utils.js`)

**Medium (21 fixed):**
- **Blur-clamping IDs don't match HTML** — Auto-suggest and decay input IDs in `inputToConstraint` map had wrong naming (`dle_auto_suggest_*` vs `dle_autosuggest_*`, `dle_decay_boost` vs `dle_decay_boost_threshold`). 5 inputs never clamped. (`src/settings-ui.js`)
- **Empty tag fields silently disable features** — Clearing constantTag/neverInsertTag/seedTag/bootstrapTag fields saved empty strings, silently disabling those features. Now falls back to defaults. (`src/settings-ui.js`)
- **Vault port accepts negative numbers** — Clamped to 1-65535. (`src/settings-ui.js`)
- **AI search cache holds stale entry refs** — Cache stored direct VaultEntry references that went stale after index rebuilds. Now caches by title, resolves to current entries on hit. (`src/ai.js`)
- **Premature chatLines split** — `chatContext.split('\n')` ran before the exact-match cache check that made it unnecessary. Deferred via lazy getter. (`src/ai.js`)
- **Stale cache after failed background rebuild** — `setIndexTimestamp(Date.now())` on hydration failure prevented retries until TTL expired. Now sets timestamp for ~30s retry. (`src/vault.js`)
- **`buildIndexDelta` never sets `indexEverLoaded`** — Successful delta syncs left `indexEverLoaded` false, causing misleading "No vault entries loaded" toasts. (`src/vault.js`)
- **`buildIndexDelta` race condition** — Guard check before `setIndexing(true)` had a 19-line gap allowing duplicate concurrent deltas. Moved flag immediately after guard. (`src/vault.js`)
- **Scribe writes metadata to wrong chat** — `chat_metadata` reference could swap during async `writeNote`. Added epoch re-check after write. Also fixed stale `lastScribeChatLength`. (`src/scribe.js`)
- **WI import content injection** — Imported content could contain YAML delimiters (`---`), `%%deeplore-exclude%%` blocks, or Obsidian comments. Now sanitized. (`src/import.js`)
- **`yamlEscape` misses newlines/tabs** — Strings with `\n`, `\r`, or `\t` passed through unquoted, breaking YAML structure. (`src/import.js`)
- **WI import wrong position mapping** — ST position 3 (after_AN) mapped to `'before'` instead of `'after'`. (`src/import.js`)
- **`matchWholeWords` NFD mismatch** — Regex tested against raw text while pattern was NFC-normalized. macOS input methods produce NFD, causing match failures. Now tests against normalized haystack. (`core/matching.js`)
- **Contextual gating exact match** — `era.includes(activeEra)` required exact string match. "tavern" wouldn't match "The Tavern". Now uses case-insensitive bidirectional substring matching. (`index.js`)
- **Injection dedup ignores content changes** — Dedup key didn't include content hash, so updated entries were suppressed. Added `contentHash` to dedup key. (`index.js`)
- **Cartographer button injection race** — Fixed 100ms timeout replaced with retry-with-backoff for slow DOM rendering. (`index.js`)
- **Circuit breaker blocks Test Connection** — User-initiated test was rejected by circuit breaker with implementation-detail error. Now bypasses circuit for explicit tests. (`src/obsidian-api.js`)
- **API key fragment leakage in errors** — Proxy error responses truncated and scrubbed of `sk-*` patterns. (`src/proxy-api.js`)
- **Block scalar drops blank lines** — YAML `|` block scalars terminated on blank lines within paragraphs. (`core/utils.js`)
- **Frontmatter rejects dotted keys** — Key regex `\w[\w-]*` couldn't match `character.name`. Added `.` to allowed chars. (`core/utils.js`)
- **`probability: .5` parsed as string** — Numeric regex required leading digit. `.5` silently became string, defaulting to 100% instead of 50%. (`core/utils.js`)

**Also fixed:** Inline array escape handling, quoted array item quote preservation.

### Deferred (29 bugs, documented for post-release)
- N+1 HTTP request storm in `fetchAllMdFiles` (performance)
- `buildIndexDelta` re-fetches all content (performance)
- Multi-vault title collisions in link resolution (data integrity)
- Orphaned `generateQuietPrompt` after timeout (race condition)
- `resolveLinks` mutates entries visible through snapshots (race condition)
- `autoSuggestMessageCount` is dead state (cleanup)
- Graph popup `requestAnimationFrame` leak (performance)
- Sync polling never stops when disabled (resource leak)
- Health grade inconsistency between quick action and badge (UI)
- Notebook controls not disabled when feature off (UI)
- Duplicate vault names on Add (UI)
- Stale depth/role after switching injection mode (UI)
- Various slash command toast issues (UX)
- Plaintext API key storage (security, needs ST secrets API)
- AI search prompt injection via summaries (inherent to AI retrieval)
- No AI call rate limiting (design decision)

---

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
- **Budget-Aware Entry Truncation** — Entries that exceed the remaining token budget are now truncated to fit (using clean sentence boundaries) instead of being silently dropped. Truncated entries are marked with `_truncated` flag and show original token count in diagnostics. Minimum threshold of 50 tokens prevents uselessly small fragments.
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
- **Health badge click handler accesses wrong properties** — Click handler referenced `result.grade` and `result.items`, but `runHealthCheck()` returns `{ issues, errors, warnings }`. Badge showed "Grade: undefined" on click. Now computes grade locally and iterates `result.issues` with correct `severity`/`detail` fields.
- **`/dle-summarize` loses user edits** — Textarea value was read via `getElementById` after popup resolved, but DOM was already destroyed. User edits to generated summaries were silently discarded. Now captures textarea reference in `onOpen` callback.
- **`writeNote()` silent data loss** — Obsidian 400/405 errors returned only "HTTP 405" with no response body. Combined with circuit breaker treating 4xx as successes, misconfigured scribe folders silently failed every write. Now includes response body in error message.
- **`gated.slice` returns wrong entries after budget skip** — When the highest-priority entry exceeded the token budget, `injectedEntries` was computed via positional slice rather than tracking actual accepted entries. Cooldown, decay, analytics, and Context Cartographer all recorded wrong entries. `formatAndGroup()` now returns the accepted entry list directly.
- **Test Match popup repeats same `gated.slice` bug** — The settings UI Test Match button used `gated.slice(0, injectedCount)` to display injected entries, identical to the `index.js` bug above. When `formatAndGroup` skipped an early entry via `continue`, the popup showed wrong entries as "injected" and wrong entries as "budget cut". Now uses `acceptedEntries` directly.
- **IndexedDB cache hydration bypasses validation** — Cached entries loaded from IndexedDB were injected into the vault index without structural validation. Corrupt cache data (from browser crashes or quota pressure) could propagate as canonical entries, surviving restarts. Added `validateCachedEntry()` checkpoint during hydration.

**High:** 56 fixes — generation lock feedback, `_rawContent` memory doubling, scanText per-entry allocation, cascade/recursive bypass of cooldown/warmup/probability, multi-vault migration loop, first-entry budget overflow, cumulative decay penalty, manifest 4x filter passes, incomplete cache key, undiagnosable profile errors, circuit breaker mid-batch/5xx/auth/singleton/half-open-stampede issues, unauthenticated testConnection, AI-only fallback collapse, delta sync vault loss, pinned entries filtered by post-pin gates, zero-lore window in commands, bootstrap invisible after threshold, empty key matching everything, optimize-keys crash, graph animation leak, YAML corruption via JSON.stringify, setup wizard DOM read-after-close, import overwrites, Promise.all failures, CHAT_CHANGED cache invalidation, profile token tracking, word boundary regex, tracker key collisions, JSON parse errors, title/name mismatch, XML injection in templates, unsanitized scribe output, disabled button guards, settings-keyed cache, multi-vault cache key, pre-filter matching, unlimited defaults, AI parser validation/regex, health badge input, loading states, concurrent generation lock, decay threshold implementation, sliding window O(V*N), browse popup allocation, refresh index clear, premature indexEverLoaded, Cartographer memory leak, PM prompt re-registration, analytics key format, per-gen decay iteration.

**Medium:** 66 fixes — pipeline crash feedback, orphaned quiet prompts, analytics/cache/settings lifecycle, SSRF validation, gating/matching correctness, Unicode normalization, import error handling, case-sensitivity (5 instances), CHAT_CHANGED state resets (5 instances), YAML injection/escaping (4 instances), cache schema/TTL/quota, sync polling, UI event listeners, DOM read-after-close, epoch guards, plus 9 from pre-release audit (decay penalty, AI normalization, numeric YAML gating, apostrophe parsing, vaultIndex snapshot, block scalars, token tracking, import escaping, lock guard).

**Low:** 50 fixes — falsy-zero coalescing, recursion bounds, API signatures, click delegation, tracker key mismatches, cooldown timer freeze, tag cache invalidation, prompt injection guards, shared mutable defaults, regex recompilation, dead code removal, analytics pruning, prototype pollution, filename collisions, hash upgrades, import bounds, graph performance, plus 3 from pre-release audit (2-char key cache, scribe chat length, null chat guard).

*(Deferred)* Magic number imports, YAML parser docs, inline styles → CSS, ARIA labels — documented in plan for future work.

### Internal
- `/dle-inspect` now shows full post-pipeline state: Injected entries (with token counts and truncation markers), Gated Out entries (with requires/excludes reasons), and Budget/Max Cut entries. Previously only showed keyword matches and AI selections.
- Pipeline trace (`lastPipelineTrace`) now populates the previously-empty `gatedOut`, `budgetCut`, and `injected` arrays, plus `totalTokens` and `budgetLimit`.
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
- 227 passing tests
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
