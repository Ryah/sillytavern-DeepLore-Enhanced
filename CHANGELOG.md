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

### Self-Healing Diagnostics
- Expanded `/dle-health` from ~7 to 30+ checks: circular requires, duplicate titles, conflicting overrides, orphaned cascade links, AI/Scribe misconfiguration, budget warnings, probability zero, unresolved wiki-links, keyword conflicts, and more.
- Auto-runs on extension load, surfaces warnings via toast (silent if clean).

### Refactor: Module Decomposition
- Decomposed monolithic `index.js` (4619 lines) into 13 focused modules. `index.js` is now ~270 lines (entry point + `onGenerate`).
- New modules: `settings.js`, `src/state.js`, `src/vault.js`, `src/ai.js`, `src/pipeline.js`, `src/sync.js`, `src/scribe.js`, `src/auto-suggest.js`, `src/cartographer.js`, `src/popups.js`, `src/diagnostics.js`, `src/settings-ui.js`, `src/commands.js`.

### Bug Fixes
- **Shared mutable defaults** — `getSettings()` assigned raw object references from `defaultSettings` for `vaults: []` and `analyticsData: {}`, so mutations could corrupt defaults. Now deep-clones non-primitive defaults.
- **Manifest header count wrong in two-stage mode** — `buildCandidateManifest()` reported "from N total" using the full vault count instead of the actual candidate count. AI received a misleading header.
- **First entry budget bypass undocumented** — `formatAndGroup()` always accepts the first entry even if it exceeds the token budget (by design, to avoid empty results). Added a debug-mode warning when this happens.
- **Client AI response parser too permissive** — `extractAiResponseClient()` accepted any JSON array without validation. Now checks that array contents are strings or objects with `title`/`name`, matching the server parser's robustness.
- **Server `||` on timeout/maxTokens** — `timeout || 15000` and `maxTokens || 1024` treated explicit `0` as falsy. Changed to `??` (nullish coalescing).
- **Directory recursion off-by-one** — `listAllFiles()` allowed 21 nesting levels instead of 20. Fixed `> 20` to `>= 20`.
- **Cooldown timer freeze** (critical) — Early returns in `onGenerate()` skipped `generationCount++` and cooldown decrement, permanently freezing cooldown timers during quiet generations. Fixed with `pipelineRan` flag + `finally` block.
- **Test Match pipeline order** — Simulation ran gating before cooldown, opposite to actual `onGenerate` order. Reordered to match.
- **`/dle-context` missing cooldown filter** — Command showed entries blocked by re-injection cooldown. Now applies cooldown filter before gating.
- **Case-insensitive orphan detection** — Health check used case-sensitive comparison for requires/excludes/cascade_links while `applyGating()` is case-insensitive. Fixed all five instances.
- **Case-insensitive graph edges** — Relationship graph used case-sensitive title lookups. Fixed to match runtime behavior.
- **Case-insensitive wiki-link resolution** — Unresolved wiki-link check in diagnostics was case-sensitive. Fixed.
- **Depth/role override warning** — Health check warned about depth overrides without considering global injection position default. Now checks effective position.
- **`generateQuietPrompt` API** — Wrong API call signature for quiet generation.
- **Scribe-notes HTTP status** — Missing HTTP status check on scribe-notes fetch.
- **Auto-suggest scan depth** — Incorrect scan depth used for auto-suggest AI context.
- **Greedy regex in `extractAiResponseClient`** — JSON array extraction used greedy `[\s\S]*` instead of lazy `[\s\S]*?`, capturing too much text.
- **`Number || default` falsy-zero** — `Number(val) || default` treated valid 0 as falsy. Fixed with `isNaN()` checks.
- **Warning ratio reset** — `lastWarningRatio` not reset on chat change, causing stale toast suppression.

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

### New Frontmatter Fields
| Field | Type | Description |
|-------|------|-------------|
| `probability` | number | Chance of triggering when matched (0.0-1.0, null = always) |

### Settings
- New AI Notebook section: enable, injection position, depth, role
- New `stripDuplicateInjections` and `stripLookbackDepth` in Matching & Budget
- New Auto Lorebook section: enable, interval, connection mode, profile, proxy, model, tokens, timeout, folder
- New `optimizeKeysMode` (keyword-only / two-stage)
- New `vaults` array replacing single-vault connection fields (auto-migrated)

### Internal
- New `probability` and `vaultSource` fields on VaultEntry (shared core — additive)
- New server endpoint `POST /scribe-notes` for session timeline
- `chat_metadata` now stores: `deeplore_notebook`, `deeplore_lastScribeSummary`, `deeplore_injection_log`
- `matchEntries()` now returns `probabilitySkipped` array
- `onGenerate()` uses `pipelineRan` flag + `finally` block for generation tracking
- 191 passing tests
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
