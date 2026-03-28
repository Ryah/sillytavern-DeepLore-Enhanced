# Changelog

## 0.2.1-BETA

### Stabilization Sprint (2026-03-27)

Targeted 13 remaining HIGH-priority bugs and 3 refactors identified by the comprehensive code audit. Focused on multi-vault correctness, AI search reliability, infrastructure cleanup, and documentation sync.

#### Refactoring
- **R8**: Consolidated 4 inline `isForceInjected` definitions (3 logic variants) into a single shared function in `helpers.js`. Zero behavioral change — each call site passes `{ bootstrapActive }` context.
- **R5**: Graph module (`graph.js`, ~3140 LOC) is now lazy-loaded via dynamic `import()` only when `/dle-graph` runs. Reduces startup parse cost by ~21%.
- **R7**: Consolidated 5 inline XML escape implementations into shared `escapeXml()` in `core/utils.js`. Used by `core/matching.js` and `src/ai/ai.js`. Graph modules keep local copies (can't import ST paths in test context).

#### Bug Fixes
- **H3**: `hydrateFromCache` background rebuild now captures `chatEpoch` before starting. Skips stale retry-timestamp logic if epoch changed during rebuild.
- **H12**: AI response titles now fuzzy-matched (Dice coefficient, threshold 0.6) against the candidate manifest when exact match fails. Catches typos and minor variations in AI-returned titles.
- **H13**: Hierarchical pre-filter prompt expanded from one terse sentence to detailed selection criteria with examples. Includes character/place mentions, scene themes, background context guidance.
- **H14**: Auto-suggest entry titles are now wrapped in escaped double quotes before prompt injection, preventing special characters from breaking the prompt structure.
- **H15**: Added token budget guidance bullet to AI system prompt: "Respect the token budget shown in the manifest header."
- **H16**: Switching from `prompt_list` to `extension` injection mode now empties stale Prompt Manager entries (`deeplore_constants`, `deeplore_lore`, `deeplore_notebook`).
- **H18**: Multi-vault merge mode now handles all fields, not just `keys`. Arrays (keys, tags, links) are unioned; content is concatenated with separator; summary prefers first non-empty; scalars prefer first; tokenEstimate recalculated.
- **H20**: `finalizeIndex()` now calls `pruneOrphanedCacheKeys()` to clean up stale IndexedDB entries from disabled/removed vaults.
- **H23**: Pin/block storage migrated from bare title strings to `{ title, vaultSource }` objects. Multi-vault "all" mode no longer cross-matches entries with the same name across different vaults. Legacy bare strings auto-normalize to match any vault (backward compatible).

#### Documentation
- CHANGELOG: Added this 0.2.1-beta section.
- Wiki: Fixed 5 HIGH inaccuracies in Settings-Reference.md (scribe timeout default/range, missing host field, missing Skip Review toggle) and Injection-and-Context-Control.md (gating field types).
- Roadmap: Marked 4 shipped items (Browse List Virtualization, Neighborhood Isolation, Entry Clustering, Dead Entry Detection).
- CLAUDE.md: Fixed incorrect field types, added missing files/modules/state variables, updated stale export lists.

#### Tests
- Updated existing test assertions for the `buildExemptionPolicy` return type change (Set → Array of objects).

## 0.2.0-BETA

### 47-Bug Audit Fix (2026-03-27)
Comprehensive code audit resolved 47 confirmed bugs (2 critical, 13 high, 20 medium, 12 low). Extracted `src/vault/bm25.js` for testability. Added 72 unit tests and 25 integration tests (659→731 unit, 165→190 integration).

#### Critical
- **BUG-001**: Multi-vault all-fail no longer wipes the in-memory index — sets a short retry TTL instead.
- **BUG-002**: XML-escape `resolvedLinks` in AI manifest to prevent malformed XML from `&`/`<`/`>`/`"` in titles.

#### High
- **BUG-003**: Re-check TTL after `buildIndexWithReuse` to prevent double full-rebuild.
- **BUG-004**: Pipeline trace now includes `aiError` message for diagnostics (`/dle-inspect`).
- **BUG-005**: AI timeout errors (`AbortError`) no longer trip the circuit breaker.
- **BUG-006**: Hierarchical pre-filter no longer throttled against the main AI call rate limiter.
- **BUG-007**: Multi-vault dedup applied consistently in both `buildIndex` and `buildIndexWithReuse`.
- **BUG-010**: AI parse failures now call `recordAiFailure()` so the circuit breaker counts them.
- **BUG-011**: `forceInject`, `pins`, and `blocks` Sets normalized to lowercase for case-insensitive matching.
- **BUG-013**: BM25 index uses `trackerKey` (vaultSource:title) for multi-vault uniqueness.
- **BUG-015**: `buildEpoch` counter invalidates stale build promises after force-release.
- **BUG-019/020/021**: AI search cache key now includes system prompt hash, confidence threshold, manifest summary mode, and summary length.
- **BUG-028**: Connection Manager profile calls wrapped with `Promise.race` timeout.
- **BUG-029**: Symmetric mutual excludes resolve deterministically — higher-priority entry survives.

#### Medium
- **BUG-008**: `convertWiEntry` handles string `key` field without crashing.
- **BUG-009**: `parseFrontmatter` filters `null`/`undefined` from array fields.
- **BUG-012**: IndexedDB `saveIndexToCache` validates `tokenEstimate` to prevent `NaN` propagation.
- **BUG-014**: `formatAndGroup` called with current settings object, not stale closure.
- **BUG-016**: Lenient contextual gating tolerance no longer skips all filtering.
- **BUG-017**: Hierarchical pre-filter no longer increments `aiSearchStats.calls`.
- **BUG-018**: Sync polling uses epoch counter to prevent orphaned chains.
- **BUG-022**: Hierarchical pre-filter receives post-recursive-scan entries (preserves wiki-links).
- **BUG-024**: IndexedDB `tx.onabort` handler added to surface quota/constraint errors.
- **BUG-025**: AI circuit breaker half-open probe uses atomic gate (prevents thundering herd).
- **BUG-027**: Hierarchical AI response parser handles object format (`.categories`/`.labels`/`.selected`).
- **BUG-030**: Pinned entries get deep-copied arrays to prevent cross-mutation.
- **BUG-032**: Token-to-char truncation ratio changed from 3.5 to 4.0 for better alignment.
- **BUG-033**: YAML unescape applied after quote stripping (correct order).
- **BUG-034**: `setBuildPromise(null)` called on force-release of stuck indexing flag.
- **BUG-035**: Warmup check skipped for cascade-linked entries.
- **BUG-036**: Dead hostname check removed from proxy URL validation.
- **BUG-037**: `127.x.x.x` range added to SSRF private IP patterns.
- **BUG-039**: `_lastAiCallTimestamp` update moved to `finally` block.
- **BUG-042**: BM25 query uses `Set` instead of `Map` for deduplication (frequency was allocated but unused).

#### Low
- **BUG-023**: IndexedDB `loadIndexFromCache` validates `tokenEstimate` on read.
- **BUG-026**: Clarifying comment on analytics pruning intent.
- **BUG-031**: IndexedDB `saveIndexToCache` clamps `tokenEstimate` floor to 1.
- **BUG-038**: Obsidian circuit breaker `circuitAllows` dead code simplified.
- **BUG-040**: `validateVaultPath` check added to `fetchScribeNotes` folder parameter.
- **BUG-041**: Proxy response parsing separates `response.text()` from `JSON.parse` try-catch.
- **BUG-043**: Short entity names (≤3 chars) use word-boundary regex in mention-weight.
- **BUG-044**: `setBuildPromise(null)` in all `buildIndex` finally blocks.
- **BUG-045**: Exported `pruneCircuitBreakers(activeKeys)` for stale breaker cleanup.
- **BUG-046**: `extractAiResponseClient` validates array elements have non-empty titles.
- **BUG-047**: Hierarchical manifest header uses `candidates.length` not `selectable.length`.

#### New File
- **`src/vault/bm25.js`** — Extracted pure BM25 functions (`tokenize`, `buildBM25Index`, `queryBM25`) from `vault.js` for Node.js testability.

### Drawer: Phase 2 — Performance & UX Polish
- **Overlay mode** — When `chat_width >= 60`, drawer switches to a fixed 380px overlay instead of inline fillRight, preventing it from being crushed in narrow remaining space. Reads `power_user.chat_width` directly.
- **Close button** — Chevron-up icon next to lock icon for easy drawer dismissal. Wrapper div `.dle-drawer-controls` groups lock + close.
- **Tab count badges** — Why? tab shows injected count, Browse shows vault total, Gating shows active filter count. Badge spans with `data-badge` attribute, CSS `:not(:empty)` toggle.
- **Pre-computed tag cache** — Tag dropdown options rebuilt only on index update (`onIndexUpdated` callback), not every Browse render. Module-level `cachedTagSet`/`cachedTagOptions`.
- **Gating impact counts** — Each active gating field shows "filtering N" count indicating how many entries have the field set but don't match.
- **Virtual scroll** — Browse tab renders only visible window (~20 DOM nodes) instead of all 131+. `BROWSE_ROW_HEIGHT=32px`, `BROWSE_OVERSCAN=8`. Uses RAF-throttled scroll handler with `getBoundingClientRect` for offset calculation.
- **Click-to-expand entry previews** — Click entry name area to see summary + token count + Obsidian link inline. Overlays subsequent entries with z-index. Expanded state persists across virtual scroll re-renders.
- **Narrow drawer container query** — `@container (max-width: 200px)` hides secondary content when squeezed.

### Drawer: Phase 2 — Bug Fixes
- `offsetTop` replaced with `getBoundingClientRect` for robust virtual scroll offset calculation
- Scroll reset on filter change (prevents empty results when scrolled)
- Browse tab re-render on tab switch (prevents truncated list after hidden render)
- Close button open-guard (prevents toggle-reopen)
- Button CSS reset: margin + font-family
- Entries bar added to `@container (max-height: 250px)` rule
- Expanded entry state preserved across virtual scroll re-renders

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
- Decomposed monolithic `index.js` (4619 lines) into 19 focused modules. `index.js` is now ~620 lines (entry point + `onGenerate`).
- New modules: `settings.js`, `src/state.js`, `src/vault.js`, `src/ai.js`, `src/pipeline.js`, `src/sync.js`, `src/scribe.js`, `src/auto-suggest.js`, `src/cartographer.js`, `src/popups.js`, `src/diagnostics.js`, `src/settings-ui.js`, `src/commands.js`, `src/stages.js`, `src/helpers.js`, `src/cache.js`, `src/import.js`, `src/obsidian-api.js`, `src/proxy-api.js`, `src/toast-dedup.js`.

### Bug Fixes
- **Critical:** 9 fixes
- **High:** 67 fixes
- **Medium:** 74 fixes
- **Low:** 53 fixes

*(Deferred)* Magic number imports, YAML parser docs, inline styles → CSS, ARIA labels — documented in plan for future work.

### Internal
- `/dle-inspect` now shows full post-pipeline state: Injected entries (with token counts and truncation markers), Gated Out entries (with requires/excludes reasons), and Budget/Max Cut entries. Previously only showed keyword matches and AI selections.
- Pipeline trace (`lastPipelineTrace`) now populates the previously-empty `gatedOut`, `budgetCut`, and `injected` arrays, plus `totalTokens` and `budgetLimit`.
- New `probability`, `vaultSource`, `era`, `location`, `sceneType`, `characterPresent` fields on VaultEntry
- New modules: `src/cache.js` (IndexedDB persistent cache), `src/import.js` (WI import bridge)
- Scribe session timeline fetched directly from Obsidian (no server endpoint needed)
- `chat_metadata` now stores: `deeplore_notebook`, `deeplore_lastScribeSummary`, `deeplore_injection_log`, `deeplore_pins`, `deeplore_blocks`, `deeplore_context`
- `matchEntries()` now returns `probabilitySkipped` array
- `onGenerate()` uses `pipelineRan` flag + `finally` block for generation tracking
- `aiSearchCache` shape: `{hash, manifestHash, chatLineCount, results}` for sliding window cache
- New state: `decayTracker`, `lastHealthResult`
- Init hydrates from IndexedDB cache, falls back to full Obsidian fetch
- Delta sync fetches file listing first, downloads only new files
- 518 passing tests
- Bumped version to 0.2.0-BETA

## 0.14.0-ALPHA

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
- Scribe proxy mode routes through ST's built-in CORS proxy (no custom server endpoint)
- `runScribe()` now uses `buildAiChatContext()` from `core/utils.js` for consistent message formatting
- Scribe profile dropdown auto-refreshes on Connection Manager profile events
- Bumped version to 0.14-ALPHA

## 0.13.0-ALPHA

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

## 0.12.0-ALPHA

### New Features
- **Active Character Boost** -- New `characterContextScan` setting. When enabled, automatically matches the active character's vault entry by name or keyword, ensuring their lore is available whenever they're in the conversation.
- **Pipeline Inspector** -- New `/dle-inspect` slash command. Shows a detailed trace of the last generation pipeline: keyword-matched entries with trigger keywords, AI-selected entries with confidence and reasons, fallback status, and pipeline mode.

### Internal
- 158 passing tests
- Bumped version to 0.12-ALPHA

## 0.11.0-ALPHA

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

## 0.10.0-ALPHA

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
