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
| **Custom Fields in AI Manifest** | M | Send custom frontmatter field values to AI in the candidate manifest so the AI can use field metadata (era, mood, faction, etc.) as selection criteria. |
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
| ~~**Entry Clustering / Smart Grouping**~~ | ~~M~~ | ✅ Shipped in v0.2.0. Hierarchical pre-filter clusters by category; graph has Louvain clustering + gap analysis. |
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
| ~~**Browse List Virtualization**~~ | ~~M~~ | ✅ Shipped in v0.2.0. Virtual scroll with 32px row height, 8-row overscan, absolute positioning. |
| **Story Timeline View** | M | Scrollable timeline of Session Scribe notes with one-click expansion to full summaries. Replace popup-based `/dle-scribe-history` with a persistent view. |
| **Debug Mode Lite** | M | In-drawer panel showing live matching traces, pipeline decisions, and cache state — avoiding the need for browser console or `/dle-inspect`. |
| **Selectable Graph Algorithm** | M | Let users choose between different graph layout algorithms (force-directed, radial, hierarchical, etc.) for different vault structures and visualization needs. |

---

## Graph Visualization (`/dle-graph`)

| Feature | Size | Description |
|---------|------|-------------|
| **Live Pipeline Trace Overlay** | M | During generation, graph nodes light up in real-time showing pipeline stages: keyword-matched = green, AI-selected = bright, budget-cut = red, gated = gray. Hover any node for full diagnosis. The missing link between `/dle-inspect` and real-time understanding. |
| **Live Generation Sync** | M | If graph popup is open during generation, animate which entries are being considered/selected/rejected. After generation, state persists for inspection. |
| **Generation Timeline Scrubber** | L | Slider at bottom scrubs through chat history generation-by-generation. Shows which entries were active at each step. Like git blame for lore injection. |
| **Sketch & Auto-Create Mode** | L | Draw connections directly on the graph. Click empty space to create a new entry skeleton. Drag between nodes to create requires/excludes edges. Writes back to Obsidian via `writeNote()`. Turns the graph into a worldbuilding tool. |
| **Interactive HTML Export** | M | Export graph as a standalone .html file with bundled renderer, zero dependencies. Collaborators open in browser, explore vault structure without SillyTavern. |
| **AI Auto-Suggest Connections** | M | AI analyzes the manifest and suggests "these entries should be linked." One-click "Create Link" writes wikilinks to Obsidian. Surfaces hidden relationships. |
| ~~**Dead Entry Detection Cluster**~~ | ~~S~~ | ✅ Shipped in v0.2.0. Orphan nodes clustered in separate grid, gap analysis overlay highlights them. |
| **Budget Allocation Simulator** | M | Sidebar showing projected token cost: "If these N entries inject, tokens = X, budget remaining = Y." Drag entries into a "likely" list to plan budget before vault changes. |
| **"What If" Sandbox** | M | Toggle entries on/off and simulate what would inject. Test dependency chains before running `/dle-simulate` on a full chat. |
| **Alternative Layouts** | M | Layout dropdown: force-directed (current), family tree (character hierarchies), org chart (factions), timeline (by era field), dependency DAG (requires chains as tree). Animate transitions between layouts. |
| **Path Finding** | M | Select two nodes, highlight shortest path (BFS). Show edge types along the path. Optional: K-shortest-paths for alternatives. Answers "how does this entry unlock that entry?" |
| ~~**Neighborhood Isolation**~~ | ~~M~~ | ✅ Shipped in v0.2.0. Ego-centric focus mode with N-hop BFS depth, +/- controls, breadcrumb exit, camera fit. |
| **Multi-Select & Bulk Actions** | M | Shift+click to multi-select, lasso draw. Bulk pin/block, export subset, compare properties, health check selected. |
| **Node Detail Panel** | M | Click a node to open a side panel with 4 tabs: Metadata, Links (incoming/outgoing with types), Content preview, Actions (pin/block/open in Obsidian/health check). Pattern from Context Cartographer popup. |
| **Comparison / Diff Mode** | L | Side-by-side graph view after index rebuild. Nodes colored by change type: green = added, red = removed, yellow = modified. Summary: "Added: 3, Removed: 1, Modified: 5." Uses `detectChanges()` from core/sync.js. |
| **Per-Era Graph Views** | M | Filter graph by era (frontmatter field). Show only entries for a specific era. Cross-era edges highlighted to show historical continuity. |
| **Coverage Analysis** | M | Click an entry to show its transitive closure — which entries become reachable through cascade and require chains. Helps identify orphaned subtrees and over-connected clusters. |
| **Injection Heatmap Animation** | M | Radar sweep or pulse animation highlighting recently-injected entries. Node colors shift blue→red based on per-chat injection counts. Surfaces overused and dead entries at a glance. |
| **Graph Description Generator** | S | Generate a natural-language summary of graph structure for screen readers and documentation. "The vault contains 47 entries: 3 major hubs, 12 isolated characters, 4 dead entries..." |
| **Lens Mode** | M | Magnifying glass cursor for exploring dense regions without zooming. Circle shows zoomed detail; everything outside fades. |
| **Drag-to-Create Edges** | L | Alt+drag from node to node → dropdown to pick edge type (link/requires/excludes/cascade) → writes to Obsidian frontmatter. Right-click edge to delete. |
| **Minimap** | S | 150x150px corner minimap showing full graph with viewport rectangle. Click to navigate. |

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

*Sources: Reddit ([v0.14 post](https://www.reddit.com/r/SillyTavernAI/comments/1ruxeqy/deeplore_enhanced_aipowered_lorebook_injection/), [v0.2.0 post](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/)), GitHub issues ([#3](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/3), [#5](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/5)), 5-expert code audit (2026-03-19), 8-agent comprehensive audit (2026-03-23), 5-perspective review + fixes (2026-03-23), 6-agent graph popup audit (2026-03-24).*

*Last updated: 2026-03-27*
