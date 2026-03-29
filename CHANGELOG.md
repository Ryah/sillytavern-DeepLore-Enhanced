# Changelog

## 0.2.0-BETA

### AI Notepad, Import Summaries & Timeout Caps (2026-03-28)

#### AI Notepad (new feature)
- **AI-written session notes** — The AI can maintain running notes about important story details (decisions, relationship changes, revealed secrets) using `<dle-notes>` tags. Notes are stripped from the visible chat, accumulated per-chat in `chat_metadata`, and reinjected into future messages as context.
- **Configurable injection** — Position, depth, and role controls (same pattern as Author's Notebook). Custom instruction prompt override available.
- **Per-message tracking** — Each message's extracted notes stored on `message.extra.deeplore_ai_notes` and visible in Context Cartographer popup.
- **`/dle-ai-notepad`** — View/edit accumulated notes with token count, or `/dle-ai-notepad clear` to reset.
- **Settings UI** — Enable toggle, injection controls, and custom prompt textarea in Features tab.

#### AI Summaries on Import
- **`/dle-import` → summarize piping** — After importing World Info entries, DLE offers to generate AI summaries for imported entries that only have placeholder text. Reuses the `/dle-summarize` pipeline.
- **Extracted `summarizeEntries()`** — Shared function in `commands-ai.js` used by both `/dle-summarize` and the import flow.

#### Local LLM Timeout Caps
- **Raised timeout limits** — AI Search timeout cap raised from 30s → 120s. Auto-suggest timeout cap raised from 60s → 120s. Scribe was already 120s.
- **Local LLM guidance** — Tooltip hints on all timeout inputs: "Local LLMs may need 60-120s. Cloud APIs typically respond in 5-15s."
- **Wiki updates** — Settings Reference, AI Search, and Troubleshooting pages updated with new ranges and local LLM guidance.

### Custom Frontmatter Fields (2026-03-28)

> **Highlights:** Contextual gating is now fully customizable. Define your own frontmatter fields (mood, faction, time_of_day — anything), configure gating rules, and manage everything from a visual editor. The four built-in fields (era, location, scene_type, character_present) are now just defaults.

#### Custom Field System
- **Field Definition Editor** — Visual rule builder popup (`Manage Fields` button in Gating tab or Settings) to create, edit, reorder, duplicate, and delete custom gating fields. Supports text, number, boolean, and list types with per-field gating operators (equals, contains, any_of, none_of) and tolerance levels.
- **YAML-backed definitions** — Field definitions stored in Obsidian vault (`DeepLore/field-definitions.yaml`) and loaded on index build. Editable from the rule builder or by hand.
- **Generic commands** — `/dle-set-field <name> [value]` and `/dle-clear-field <name>` work for any defined field, with tab-completion for field names. Legacy `/dle-set-era` etc. are now aliases.
- **Drawer integration** — Gating tab shows status dots (set/unset), multi-value distinction, impact counts ("excluding N entries"), and an empty-state hint for new users. Manage Fields button in toolbar.
- **Browse tab filters** — Custom field filter dropdowns appear automatically for any field with values in the vault.
- **Graph coloring** — Color nodes by any custom field value. Legend shows field name header and "No value" swatch. Tooltip shows multi-value overflow.
- **AI manifest labels** — Field labels (not raw names) shown in AI search manifests.
- **Inspect details** — `/dle-inspect` shows per-field mismatch reasons for gated entries (e.g. `era: medieval ≠ renaissance`).
- **Status command** — `/dle-status` shows custom field count and names.
- **Settings integration** — "Edit Fields" button next to field definitions path in settings popup.
- **Missing file notification** — Toast warning when field definitions file not found in vault.

#### UI/UX Design Round (94 findings across 8 phases)
- **Rule builder UX** — Double-click save guard, unsaved changes warning on close, reset confirmation dialog, field reorder (move up/down), duplicate field, scroll-to on add, delete animation, contextKey auto-link toggle, gating-disabled dimming, boolean disables multi, error field highlighting with scroll-to, specific success messages.
- **CSS foundations** — 10 missing/incomplete CSS definitions fixed: `--dle-bg-2` variable, `.dle-gating-fields-container`, `.dle-rb-header` styling, `.dle-rb-select` theme integration, `.dle-rb-lbl` contrast fix, `.dle-rb-popup` padding, `.dle-manage-fields-btn` toolbar layout, `.dle-gating-group` hover states, chip focus-visible states.
- **Responsive** — Rule builder adapts at 1024px and 768px breakpoints.
- **Drawer icon** — Changed from FA scroll to inline Obsidian crystal SVG.

### Reliability Overhaul (2026-03-27)

> **Highlights:** 47 bugs fixed from a comprehensive code audit, 97 new tests, dramatically improved multi-vault and AI search stability, 21% faster startup, and smarter AI entry selection.

A thorough code audit identified and resolved 47 bugs across every major subsystem, followed by a stabilization sprint targeting 13 additional high-priority issues. This is the most significant stability release to date.

#### Critical fixes
- **Multi-vault resilience** — If all vaults are temporarily unreachable, your entries are preserved in memory instead of being wiped. A short retry ensures quick recovery.
- **Special characters in entries** — Entry titles containing `&`, `<`, `>`, or `"` no longer corrupt the AI search manifest.

#### AI search & matching
- **Smarter AI matching** — AI search now fuzzy-matches entry names, catching typos and minor variations in AI responses that previously caused missed entries.
- **Better AI prompts** — The category pre-filter and token budget guidance are both more detailed, helping the AI make better entry selection decisions.
- AI timeouts no longer trigger the safety pause — only genuine failures count.
- AI search cache now invalidates correctly when you change AI settings (prompt, confidence, summary mode).
- Connection Manager profile calls now have proper timeouts instead of hanging indefinitely.
- When two entries exclude each other, the higher-priority entry consistently wins.
- Pins, blocks, and force-inject are now case-insensitive — "The Crown" and "the crown" match correctly.
- Category pre-filter no longer miscounts AI usage stats or blocks the main AI call.
- Fuzzy search handles multi-vault entries correctly (no cross-vault collisions).
- Cascade-linked entries now bypass warmup requirements as intended.
- Lenient gating tolerance no longer accidentally skips all filtering.

#### Vault & storage
- **Multi-vault merge overhaul** — When merging entries across vaults, all fields are now handled correctly (keywords, tags, links, content, summaries) instead of just keywords.
- **Multi-vault pin/block fix** — Pins and blocks now track which vault an entry belongs to, so entries with the same name in different vaults are handled correctly. Existing pins/blocks are automatically migrated.
- **Storage cleanup** — Removing or disabling a vault now cleans up its cached data automatically.
- **Cache rebuild reliability** — Switching chats during a background rebuild no longer causes stale data issues.
- Index rebuilds no longer trigger redundant double-rebuilds.
- Stuck index rebuilds are now detected and automatically released.
- Sync polling handles chat switches gracefully (no orphaned background tasks).
- Storage errors (quota exceeded, write failures) are now surfaced clearly.
- Token estimates are validated on both read and write to prevent calculation errors.
- YAML frontmatter values are now unescaped in the correct order.

#### Performance
- **Faster startup** — The graph visualization module now loads on-demand instead of at startup, cutting initial load time by ~21%.

#### Diagnostics & quality-of-life
- **Cleaner injection mode switching** — Switching between injection modes no longer leaves stale entries behind in the Prompt Manager.
- **Auto-suggest stability** — Entry titles with special characters no longer break the suggestion prompt.
- `/dle-inspect` now shows AI error messages for easier troubleshooting.
- Importing lorebook entries with unusual keyword formats no longer causes errors.
- Entry truncation boundaries are more accurate (better character-to-token ratio).
- Pinned entries no longer share internal data that could cause unexpected side effects.

#### Documentation
- Wiki: Fixed 5 inaccuracies in Settings Reference and Injection & Context Control pages.
- Roadmap: Marked 4 shipped items (Browse List Virtualization, Neighborhood Isolation, Entry Clustering, Dead Entry Detection).

### Live Drawer — Performance & UX Polish
- **Smart overlay mode** — On wide chat layouts, the drawer floats over the chat instead of squeezing it, so you never lose reading space.
- **Close button** — Quick-dismiss button next to the lock icon.
- **Tab count badges** — See at a glance how many entries are injected, how many are in your vault, and how many gating filters are active.
- **Gating impact counts** — Each active filter shows how many entries it's currently blocking, so you know if your filters are too aggressive.
- **Smooth scrolling for large vaults** — Browse tab now handles hundreds of entries without slowing down (virtual scroll rendering).
- **Click-to-expand previews** — Click any entry in Browse to see its summary, token count, and a direct link to open it in Obsidian.
- **Responsive layout** — Drawer adapts gracefully to narrow and short screen sizes.

### New Features

#### World-Building Tools
- **AI Notebook** — A persistent per-chat scratchpad that the AI sees every turn. Jot down plot notes, character reminders, or session goals with `/dle-notebook` — they survive reloads and stay with the chat.
- **Auto Lorebook Creation** — AI analyzes your chat and suggests new entries for characters, locations, and concepts it notices. Review, edit, and accept — entries are written directly to Obsidian. Use `/dle-newlore` or let it run automatically.
- **Optimize Keywords** — `/dle-optimize-keys` asks AI to suggest better trigger keywords for any entry, so your lore fires when it should.
- **Auto-Summary Generation** — `/dle-summarize` writes AI search summaries for entries that are missing them, improving how well the AI selects your lore.
- **Import from SillyTavern** — `/dle-import` converts your existing SillyTavern lorebooks (World Info JSON) into Obsidian vault notes with proper frontmatter.
- **Entry Relationship Graph** — `/dle-graph` visualizes how your entries connect — requires, excludes, cascade links, and wiki-links — as an interactive force-directed graph.

#### Smarter Lore Selection
- **Roll the dice** — New `probability` field lets entries randomly appear when matched (0.0-1.0), adding variety to your lore injection.
- **Per-chat pin & block** — Force specific entries on or off for the current chat without editing your vault. `/dle-pin`, `/dle-block`, and friends.
- **Contextual gating** — Filter entries by era, location, scene type, or which characters are present. Your Victorian-era lore won't leak into the sci-fi arc.
- **Entry rotation** — Entries that haven't appeared in a while get a boost; overused entries get a penalty, keeping your lore fresh.
- **Injection deduplication** — Skip re-injecting entries that are already in the AI's recent context, saving token budget for new lore.
- **Smarter budget management** — Entries that don't fit the remaining budget are now trimmed to sentence boundaries instead of being dropped entirely. The AI also over-requests and picks the best matches by confidence.
- **Scribe-informed retrieval** — Feed the Session Scribe's latest summary into AI search, so entry selection reflects what actually happened in the story.
- **Large vault support** — Vaults with 40+ entries are automatically clustered by category for more efficient AI selection.

#### Visibility & Diagnostics
- **Entry Browser** — `/dle-browse` opens a searchable, filterable popup of all your entries with content previews, usage stats, and direct Obsidian links.
- **Activation Simulation** — `/dle-simulate` replays your chat history step-by-step, showing exactly which entries activate or deactivate at each message.
- **"Why Not?" Diagnostics** — Click any unmatched entry in Test Match to see exactly why it didn't fire and what to fix.
- **Enhanced Context Cartographer** — See token usage per entry, injection positions, expandable content previews, and vault attribution for multi-vault setups.
- **Scribe Session Timeline** — `/dle-scribe-history` fetches and displays all your session notes from Obsidian.

#### Infrastructure
- **Multi-vault support** — Connect multiple Obsidian vaults with independent settings. Entries are merged with clear vault attribution throughout the UI.
- **Zero loading delays** — Your vault index is saved to browser storage for instant page loads. Obsidian is checked in the background to ensure freshness.
- **Smart caching** — AI search results are cached and reused when only new chat messages are added (no vault changes), saving API calls.
- **Automatic error recovery** — If Obsidian goes down, DeepLore automatically backs off and retries with increasing delays instead of hammering your connection.
- **Incremental sync** — On auto-refresh, only new or changed files are downloaded instead of re-fetching everything.
- **Proxy cache optimization** — In proxy mode, the manifest is positioned to take advantage of prompt caching on supported providers.
- **Setup Wizard** — `/dle-setup` walks you through first-time configuration step by step.
- **Quick Actions Bar** — One-click buttons in settings for Browse, Health, Refresh, Graph, Simulate, Analytics, and more.

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
- **Simplified search mode** — One dropdown to pick your search strategy: Keyword Only, Two-Stage (keywords + AI), or AI Only.
- **Organized AI features** — AI Notebook, Session Scribe, and Auto Lorebook grouped into one collapsible section.
- **Cleaner settings** — Power-user options hidden behind "Show Advanced" toggles (your preferences are remembered across sessions).
- **Auto-connect** — Extension automatically connects to Obsidian on startup when enabled.
- **Helpful tooltips** — Every setting has a descriptive tooltip explaining what it does.

### Self-Healing Diagnostics
- `/dle-health` now runs 30+ automated checks on your vault: circular dependencies, duplicate titles, conflicting rules, orphaned links, misconfigured AI settings, budget warnings, and more.
- Runs automatically on startup — you'll see a toast if anything needs attention (silent when clean).

### Under the Hood
- Decomposed the codebase from one massive file (4619 lines) into 21 focused modules for better maintainability.
- 200+ bug fixes across all severity levels.
- 518 passing tests.
- Bumped version to 0.2.0-BETA.

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
