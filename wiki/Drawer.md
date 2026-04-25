# Drawer Panel

The drawer is DLE's persistent side panel. It shows live pipeline feedback during your chat: which entries were injected, why, and how your token budget is being used.

The drawer opens automatically when DLE is enabled and has data to display.

![DLE drawer panel showing the Browse tab with a scrollable entry list, Idle status indicator, 234 entries indexed, token budget bar at 1,138 tokens, and per-entry priority badges and injection counts](images/dle-drawer.png)

---

## Layout

The drawer has three zones:

1. **Status zone** (fixed at top): connection status, stats, token and entry bars, quick action buttons
2. **Tabs** (scrollable middle): five tabs with different views
3. **Footer** (fixed at bottom): context window bar, recent activity feed, health icons, AI session stats

---

## Status zone

- **Status dot**: color-coded. Green (connected, healthy), yellow (indexing or stale), red (disconnected or error).
- **Pipeline label**: current activity. "Idle", "Choosing Lore...", "Consulting vault...", "Generating...".
- **Stats row**: vault entry count and AI search mode (Two-Stage, AI Only, Keywords) at a glance.
- **Lore budget bar**: how much of your configured token budget is being used. Color gradient: green (low usage) through yellow to red (near or at budget).
- **Entry count bar**: entries injected versus configured max entries cap.
- **Active gating filters**: shows currently set era, location, scene type, characters present, folder filter, and any custom fields when set.
- **Quick action buttons** (left to right):
  - **Refresh**: reload lore from Obsidian
  - **Scribe**: run Session Scribe on the current chat
  - **New lore**: create a new vault entry from scratch
  - **Librarian chat**: open the Librarian chat session (Emma)
  - **Graph**: open the relationship graph
  - **Clear AI Cache**: clear AI search cache so the next generation re-selects from scratch
  - **Skip Librarian**: skip Librarian tools for the next generation only

---

## Tabs

### Injection tab

Shows what happened in the last generation. Tab and panel header both read "Injection".

**Filter toggle**: switch between Injected, Filtered, or Both.

**Injected entries** show:
- Entry title with match label (CONST, PIN, INIT, SEED, KEY, AI)
- For AI matches: confidence level and selection reason
- For keyword matches: the triggering keyword(s)
- Token count with color-gradient indicator
- Temperature indicator (see [Temperature heatmap](#temperature-heatmap) below)
- Browse navigation button (arrow icon): jumps to this entry in the Browse tab

**Filtered entries** show categorized rejection reasons:
- Budget and limit cuts
- Contextual gating filters
- Requires and excludes gating
- Cooldown, warmup, probability
- Re-injection cooldown
- Strip dedup
- AI rejection
- Click an entry to expand its full diagnosis

**Generation diff**: when the injected set changes between generations, badges show `+N new` and `-N removed` with brief reasons (e.g., "Bootstrap fall-off", "No longer matched").

**Toolbar buttons**:
- **Copy titles**: copies injected entry titles to clipboard
- **Full View**: opens the full `/dle-why` popup

**Entry Timers** (collapsible at the bottom) shows active per-entry state:
- Cooldown entries with generations remaining
- Stale entries (above the decay boost threshold, not recently injected)
- Decay penalties (injected too many consecutive times)

---

### Browse tab

![Browse tab with expanded filter dropdowns for Era, Location, Scene Type, and Character Present, showing a selected entry highlighted in red with CONST badges on always-inject entries](images/dle-browser.png)

Searchable, filterable list of all indexed entries. Virtual scrolling handles vaults with hundreds of entries.

**Search**: type to filter by title or keyword (300ms debounce). Press `/` to focus the search field.

**Status filters** (8 options):
- All: show everything
- Injected: entries injected in the last generation
- Pinned: entries pinned to this chat
- Blocked: entries blocked from this chat
- Constant: always-inject entries (`lorebook-always`)
- Seed: seed entries (`lorebook-seed`)
- Bootstrap: bootstrap entries (`lorebook-bootstrap`)
- Never Injected: entries that have never been injected (all-time analytics)

**Tag filter**: dropdown populated from all tags found in the vault.

**Folder filter**: dropdown populated from all Obsidian folder paths in the vault. Filters entries by folder location.

**Custom field filters**: dropdowns for any custom gating fields defined in `field-definitions.yaml` are added automatically alongside the tag filter.

**Sort options** (7 options):
- Priority ascending or descending (default: priority ascending)
- Alphabetical A-Z or Z-A
- Token count ascending or descending
- Injection count descending (most-injected first, this chat)

**Entry rows** show:
- Title, priority badge, token count
- Per-chat injection count badge (e.g., `3x`)
- Temperature heatmap coloring (see below)
- Status indicators (injected, pinned, blocked markers)

**Expand an entry** to see:
- Content preview (first 200 characters)
- Keywords list
- Pin and block toggle buttons (per-chat)
- Deep link to open in Obsidian

---

### Filters tab

The Filters tab (panel id `gating`) shows and edits the contextual gating state for the current chat.

**Folder filter section** at the top:
- Status dot (green when filter active, grey when off)
- Active folder chips
- Plus-circle button to pick folders to filter by
- "All folders active" empty state when no filter is set

**Field-by-field controls** for each defined gating field:
- **Era**: current era filter (with entry impact count: "filtering N entries")
- **Location**: current location filter
- **Scene Type**: current scene type filter
- **Characters Present**: list of characters currently flagged as present
- **Custom fields**: any user-defined gating field appears here with status dots and impact counts

Each field has an Edit button that triggers the matching `/dle-set-field` command and its browse popup.

**Toolbar buttons**:
- **Clear all gating filters**: resets every gating field to unset
- **Manage Fields** (gear icon): opens the rule builder UI to add, remove, or modify custom gating fields. Field definitions are stored in `field-definitions.yaml` in your vault. Each field has a type (`string`, `number`, or `boolean`), a gating operator (`match_any`, `match_all`, `not_any`, `exists`, `not_exists`, `eq`, `gt`, or `lt`), and a tolerance level.
- **Full View**: opens the full `/dle-context-state` popup

---

### Librarian tab

Lore gap inbox. Surfaces references the writing AI mentioned during chat that don't have matching vault entries, so you can decide whether to author them.

**Sub-tabs**:
- **Flags**: lore gaps detected during pipeline runs
- **Activity**: recent Librarian actions and draft history

Each sub-tab shows a count badge.

**Sort options**: Newest, Frequency, Urgency.

**Bulk selection**: select-all checkbox plus per-item checkboxes for batch operations on multiple gaps at once.

**Action buttons** (enabled when items are selected):
- **Open**: open the selected gap in the Librarian editor
- **Mark Done**: mark selected gaps as written
- **Remove**: hide on first click; dismiss forever on second click

**Bottom toolbar** (always visible):
- **New Entry**: create a new vault entry from scratch
- **Vault Review**: AI-guided review of your vault for coverage gaps

**Empty state** shows the same New Entry and Vault Review buttons when no gaps are recorded yet.

---

### Tools tab

Quick-access buttons for slash commands, organized in five groups:

| Group | Tools |
|-------|-------|
| **Inspect** | Health Check, Inspect, Status, Simulate |
| **Notebooks & History** | Author Notebook, AI Notebook, Scribe History |
| **AI Utilities** | AI Review, Summarize, Optimize Keys |
| **Vault Ops** | Import World Info, Graph, Refresh, Pins/Blocks |
| **Get Help** | Setup Wizard, Help |

Each button triggers the matching `/dle-*` slash command. See [[Slash Commands]] for details.

The "AI Notebook" button is wired to `/dle-ai-notepad` (the AI Notepad feature); the button label is the source's working name.

---

## Footer

- **Context window bar**: total context tokens used (prompt + lore + system) versus the response token reservation. Two-color bar: used (left) and reserved (right). Tooltip shows the breakdown.
- **Recent Activity** (collapsible): recent pipeline run summaries (entries injected, match types, timing).
- **Health icons** (five buttons, one click each):
  - Vault health (runs `/dle-health`)
  - Connection status (runs `/dle-status`)
  - Pipeline trace (runs `/dle-inspect`)
  - Cache info popup
  - AI service status (circuit breaker state, session stats)
- **AI session statistics**: calls made, cache hits, tokens used. Session-scoped: accumulates across chat switches and resets on page reload.

---

## Temperature heatmap

The Browse tab uses color tinting to show injection frequency relative to the per-chat average:

- **Hot entries** (red tint): injected more frequently than average. The deeper the red, the more over-represented this entry is.
- **Cold entries** (blue tint): injected less frequently than average, or never injected.
- **Neutral entries** (no tint): near the average injection rate.

Temperature is computed per-chat from injection counts. Constants and contextually-gated entries are excluded from the average calculation.

---

## Drawer behavior

- **Auto-opens** when DLE is enabled and has entries to display.
- **Pin toggle**: pin the drawer open so it stays visible across chat switches.
- **Overlay mode**: on wide chat layouts, the drawer floats over the chat instead of squeezing it.
- **Close button**: quick-dismiss next to the lock icon.
- **Tab persistence**: remembers your last-viewed tab across sessions. Librarian tab always lands on the Flags sub-tab.
- **Live updates**: refreshes after each generation via observer callbacks.
- **Keyboard shortcuts** (when drawer focused): `r` refresh, `s` scribe, `n` new lore, `g` graph, `/` focus search.
- **Accessibility**: ARIA roving tabindex, keyboard navigation, screen reader announcements via live region, reduced-motion support.
