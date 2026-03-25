# Drawer Panel

The Drawer is a persistent side panel that provides live feedback during your chat. It shows what DeepLore Enhanced is doing in real time: which entries were injected, why, and how your token budget is being used.

The Drawer opens automatically when DLE is enabled and has data to display.

---

## Layout

The Drawer has three zones:

1. **Status Zone** (fixed at top) — connection status, stats, token/entry bars, quick actions
2. **Tabs** (scrollable middle) — four tabs with different views
3. **Footer** (fixed at bottom) — context window bar, health indicators, AI stats

---

## Status Zone

- **Status dot** — color-coded: green (connected, healthy), yellow (indexing/stale), red (disconnected/error)
- **Pipeline label** — current search mode (Two-Stage, AI Only, Keywords Only)
- **Stats row** — entry count and pipeline mode at a glance
- **Token budget bar** — how much of your configured token budget is being used. Color gradient: green (low usage) through yellow to red (near/at budget)
- **Entry count bar** — entries injected vs. configured max entries cap
- **Active gating filters** — shows currently set era, location, scene type, and present characters (if any)
- **Quick actions** — Refresh Index, Open Settings, Run Scribe, Suggest New Lore

---

## Tabs

### Why? Tab

Shows what happened in the last generation — which entries were injected and which were filtered out.

**Filter toggle:** Switch between viewing Injected entries, Filtered entries, or Both.

**Injected entries** show:
- Entry title with match label (CONST, PIN, INIT, SEED, KEY, AI)
- For AI matches: confidence level and selection reason
- For keyword matches: the triggering keyword(s)
- Token count with color-gradient indicator
- Temperature indicator (see [Temperature Heatmap](#temperature-heatmap) below)
- Browse navigation button (arrow icon) — jumps to this entry in the Browse tab

**Filtered entries** show categorized rejection reasons:
- Budget/limit cuts
- Contextual gating filters
- Requires/excludes gating
- Cooldown, warmup, probability
- Re-injection cooldown
- Strip dedup
- AI rejection
- Click an entry to expand its full diagnosis

**Generation diff:** When the injected set changes between generations, badges show `+N new` and `-N removed` with brief reasons for removals (e.g., "Bootstrap fall-off", "No longer matched").

---

### Browse Tab

Searchable, filterable list of all indexed entries with virtual scrolling for large vaults.

**Search:** Type to filter by title or keyword (300ms debounce).

**Status filters** (8 options):
- All — show everything
- Injected — entries injected in the last generation
- Pinned — entries pinned to this chat
- Blocked — entries blocked from this chat
- Constant — always-inject entries (`#lorebook-always`)
- Seed — seed entries (`#lorebook-seed`)
- Bootstrap — bootstrap entries (`#lorebook-bootstrap`)
- Never Injected — entries that have never been injected (all-time analytics)

**Tag filter:** Dynamic dropdown populated from all tags found in the vault.

**Sort options** (7 options):
- Priority ascending/descending
- Alphabetical A-Z / Z-A
- Token count ascending/descending
- Injection count descending (most-injected first, this chat)

**Entry rows** show:
- Title, priority badge, token count
- Per-chat injection count badge (e.g., "3x")
- Temperature heatmap coloring (see below)
- Status indicators (injected/pinned/blocked markers)

**Expand an entry** to see:
- Content preview (first 200 characters)
- Keywords list
- Pin/Block toggle buttons (per-chat)
- Deep link to open in Obsidian

---

### Gating Tab

View and edit the current contextual gating filters for this chat.

- **Era** — current era filter (with entry impact count: "filtering N entries")
- **Location** — current location filter
- **Scene Type** — current scene type filter
- **Characters Present** — list of characters currently flagged as present

Each filter has an Edit button that triggers the corresponding `/dle-set-*` command with its browse popup.

**Entry Timers** section shows active per-entry state:
- Cooldown entries with generations remaining
- Stale entries (above decay boost threshold, not recently injected)
- Decay penalties (injected too many consecutive times)

---

### Tools Tab

Quick-access buttons for all DLE slash commands, organized in four groups:

| Group | Tools |
|-------|-------|
| **Diagnostics** | Health Check, Inspect, Status, Simulate |
| **AI Tools** | AI Review, Notebook, Summarize |
| **Data** | Import World Info, Optimize Keys, Graph, Scribe History |
| **Setup** | Setup Wizard, Pins/Blocks, Help |

Each button triggers the corresponding `/dle-*` slash command. See [[Slash Commands]] for details.

---

## Footer

- **Context window bar** — shows total context tokens used (prompt + lore + system) and reserved response tokens. Two-color bar: used (left) and reserved (right).
- **Health indicators** — five icons with one-click access:
  - Vault health (runs `/dle-health`)
  - Connection status (runs `/dle-status`)
  - Pipeline trace (runs `/dle-inspect`)
  - Cache info popup
  - AI service status (circuit breaker state, session stats)
- **AI session statistics** — calls made, cache hits, tokens used (session-scoped, accumulates across chat switches)

---

## Temperature Heatmap

The Browse tab uses color tinting to show injection frequency relative to the vault average:

- **Hot entries** (red tint) — injected more frequently than average. The more intense the red, the more over-represented this entry is.
- **Cold entries** (blue tint) — injected less frequently than average, or never injected.
- **Neutral entries** — near the average injection rate, no tinting.

Temperature is computed per-chat from injection counts. Constants and contextually-gated entries are excluded from the average calculation.

---

## Drawer Behavior

- **Auto-opens** when DLE is enabled and has entries to display
- **Pin toggle** — pin the drawer open so it stays visible across chat switches
- **Overlay mode** — on narrow screens (chat width > 60% of viewport), the drawer switches to an overlay that can be dismissed
- **Tab persistence** — remembers your last-viewed tab across sessions
- **Live updates** — refreshes automatically after each generation via observer callbacks (no manual refresh needed)
- **Accessibility** — ARIA roving tabindex, keyboard navigation, screen reader announcements via live region, reduced-motion support
