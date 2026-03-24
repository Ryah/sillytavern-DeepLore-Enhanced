# Roadmap

Possible future features for DeepLore Enhanced. Nothing here is promised or on a timeline — these are ideas collected from community feedback, GitHub issues, code audits, and the developer's own plans. Some may ship soon, some may never ship, and priorities can shift.

Have a feature request? [Open a GitHub issue](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/new) with the `enhancement` label.

> **Note:** Features already shipped are documented on the [[Features]] page and in the [Changelog](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/blob/staging/CHANGELOG.md).

Size estimates: **[S]** small, **[M]** medium, **[L]** large.

---

## AI & Retrieval

| Feature | Size | Description |
|---------|------|-------------|
| **Hybrid Vector Pre-Filter** | L | Use ST Vector Storage embeddings for semantic retrieval alongside keyword matching. |
| **Multi-Query Decomposition** | L | Agentic retrieval: decompose chat into sub-queries by narrative element, merge results. |
| **Injection History Awareness** | S | Prepend previously-injected entries to AI search context. Deferred due to re-picking bias concern — decay/freshness handles this better for now. |
| **Stale-While-Revalidate Index** | S | Serve the stale vault index while fetching fresh data in background. |

---

## Worldbuilding

| Feature | Size | Description |
|---------|------|-------------|
| **Continuity Watchdog** | M | AI contradiction detection: compare model responses against injected lore and flag inconsistencies. |
| **Lore Evolution via Scribe** | L | Scribe proposes vault entry updates when state-changing events happen in the story. |
| **Relationship Tracker** | M | Typed directional relationships (ally/enemy/mentor/etc.) in frontmatter, surfaced in graph and manifest. |
| **Faction Influence System** | L | Numeric influence values, inter-faction disposition maps, `/dle-factions` command. |
| **Narrative Spotlight / Scene Director** | M | Natural language spotlight conditions in frontmatter, evaluated by AI to control injection. |
| **Character Knowledge Annotations** | M | Per-character knowledge gating to prevent information leakage between characters. |
| **Procedural Lore Generation** | L | Template-based on-the-fly entry creation for uncharted territory or unexplored areas. |
| **Adaptive Injection by Pacing** | M-L | Adjust injection volume based on narrative pacing — less lore during fast action, more during exploration. |
| **Cross-Chat Continuity** | M | Import key narrative state from previous chats into new ones. |
| **Narrative Arc Templates** | L | Story arc structures with phase-dependent lore priorities (rising action gets different lore than climax). |
| **Lore Consistency Checker** | M | AI semantic contradiction detection across vault entries. |

---

## Entry Matching & Gating

| Feature | Size | Description |
|---------|------|-------------|
| **Inclusion Groups** | M | A `group` frontmatter field where only one entry per group injects per chat. User-creatable toggles with a panel UI to select which group member is active. |
| **Outlet / outletName Support** | M | Map entries to SillyTavern lorebook outlet names, or support named injection positions like "before char" and "after author's note". |
| **Fuzzy Name Matching for Commands** | S | Allow `/dle-pin`, `/dle-block`, and other entry commands to fuzzy-match titles instead of requiring exact names. |

---

## Vault & Import

| Feature | Size | Description |
|---------|------|-------------|
| **Auto-Sync from ST World Info** | M | Watch a SillyTavern lorebook JSON for changes and auto-import new entries. Bridges the gap with extensions like MemoryBooks and WREC. |
| **AI-Generated Summaries on Import** | S | Optionally spend an API call per entry during `/dle-import` to generate a real `summary` field instead of the placeholder. (Post-import summaries already available via `/dle-summarize`.) |
| **Update Existing Entries** | M | Dedicated function to update vault entries — modifying specific frontmatter fields while preserving the rest — rather than full file rewrites. |
| **Per-Chat Vault Auto-Switching** | M | Automatically assign vaults to chats instead of manual toggling, or treat folders within a vault as chat-specific lorebooks. |
| **Full Bidirectional Vault Sync** | L | Full version of the lite import bridge — two-way sync between ST World Info and Obsidian vault. |
| **Wiki-Import Pipeline** | L | Crawl Fandom/MediaWiki sites, summarize pages, and create vault entries automatically. |
| **Entry Template System** | M | Type-specific templates (character, location, lore, etc.) for Auto-Suggest created entries. |

---

## UX & Visualization

| Feature | Size | Description |
|---------|------|-------------|
| **NovelAI-Style Full Context Viewer** | L | Color-coded visualization of the entire prompt showing where each piece comes from. |
| **Token Budget Visualizer** | M | Stacked bar chart of budget allocation across entry groups. |
| **Generation Timeline** | L | Recorded pipeline history in chat_metadata, persistent timeline across generations. |
| **Batch Health Fix** | L | Auto-fix buttons on health check issues instead of just reporting them. |
| **Entry Clustering / Smart Grouping** | M | AI-powered thematic clustering of vault entries with gap analysis. |
| **Keyboard Shortcuts** | S | Ctrl+Shift+B/M/N/R for common drawer and pipeline actions. |
| **Entry Versioning / History Timeline** | M | Track changes to vault entries over time with diffs. |
| **Setup Wizard AI Connection Step** | S | Extend `/dle-setup` to also configure AI search connection (profile or proxy), not just vault connection. |
| **`/dle-summarize` Batch UX** | M | Batch mode for generating summaries across many entries with progress tracking and abort support. |
| **`/dle-set-characters` Browse Popup** | S | Rich browse-and-select popup for the character gating command, matching the style of `/dle-set-era`. |
| **Simulation Scope Disclaimer** | S | Add a note to `/dle-simulate` output clarifying that results are approximate and may differ from real generations. |
| **`/dle-review` Chat Pollution Warning** | S | Warn users that `/dle-review` injects a system message visible to the AI, which may affect subsequent generations. |
| **`color-mix()` @supports Wrappers** | S | Wrap ~25 `color-mix()` CSS usages in `@supports` blocks for browsers that don't support it. |
| **Health Icon Colorblind Indicators** | S | Add shape-based indicators (icons, patterns) alongside color for health status, improving accessibility for colorblind users. |
| **Context Bar Hide for Non-OAI Backends** | S | Hide the context token bar in the drawer footer when using non-OpenAI backends where `CHAT_COMPLETION_PROMPT_READY` never fires. |
| **Browse List Virtualization** | M | Virtual scrolling for the Browse tab entry list to handle vaults with 500+ entries without DOM bloat. |
| **Story Timeline View** | M | Scrollable timeline of Session Scribe notes with one-click expansion to full summaries. Replace popup-based `/dle-scribe-history` with a persistent view. |
| **Debug Mode Lite** | M | In-drawer panel showing live matching traces, pipeline decisions, and cache state — avoiding the need for browser console or `/dle-inspect`. |

---

## Infrastructure & Connectivity

| Feature | Size | Description |
|---------|------|-------------|
| **Phone/Mobile Support** | M | Use DLE when SillyTavern runs on a PC but the user accesses from a phone. Remote Obsidian support shipped — this is the remaining UX work. |
| **Higher/Unlimited AI Timeout** | S | Allow AI search timeout beyond the current 30,000ms cap, or disable it entirely. Scribe and Auto-Suggest already allow up to 60,000ms. |
| **Web Worker for Keyword Matching** | M | Offload regex matching off the main thread for vaults with 500+ entries. |
| **Pipeline Telemetry Dashboard** | M | Timing data, performance counters, and user-facing metrics for pipeline runs. |
| **Observer Unsubscribe Pattern** | M | Refactor state.js callback arrays to return unsubscribe functions, enabling proper cleanup if modules are ever reloaded. |

---

## Integration & Ecosystem

| Feature | Size | Description |
|---------|------|-------------|
| **Mirror Other Extensions** | L | Use Obsidian as unified storage for lore maintenance features from other extensions (MemoryBooks, WREC, etc.). |

---

## Project

| Item | Description |
|------|-------------|
| **Rebrand to "DeepLore"** | Drop the "Enhanced" suffix once enough features have landed. Base DeepLore is deprecated. |

---

*Sources: Reddit ([v0.14 post](https://www.reddit.com/r/SillyTavernAI/comments/1ruxeqy/deeplore_enhanced_aipowered_lorebook_injection/), [v0.2.0 post](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/)), GitHub issues ([#3](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/3), [#5](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/5)), 5-expert code audit (2026-03-19), 8-agent comprehensive audit (2026-03-23), 5-perspective review + fixes (2026-03-23).*

*Last updated: 2026-03-23*
