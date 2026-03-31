# Setup & Import

Getting started features and tools for migrating from other lorebook systems.

---

## Setup Wizard

A guided first-time setup experience. Walks through Obsidian vault connection, tag configuration, and search mode selection. AI search connection (profile or proxy) must be configured separately in the settings panel.

![Setup Wizard welcome screen with step indicator, explanation of the two-stage pipeline, and Next button to begin guided configuration](images/dle-setup-wizard.png)

**Usage:** `/dle-setup` or the Setup button in the Quick Actions bar.

---

## Quick Actions Bar

A toolbar of one-click buttons at the top of the settings panel for common operations. Includes two rows: always-visible actions (Browse, Map, Health, Refresh) and an expandable "More" row (Graph, Simulate, Analytics, Optimize, Inspect, Setup).

Uses SillyTavern's standard button styling with Font Awesome icons. All buttons call their functions directly (no slash command roundtrip).

---

## ST Lorebook Import Bridge

Convert SillyTavern World Info JSON exports into Obsidian vault notes with proper frontmatter. Handles three formats: WI export JSON, V2 character cards with embedded WI, and raw entry arrays.

![Import SillyTavern World Info popup with three options: select an existing lorebook from dropdown, browse a local JSON file, or paste JSON text directly](images/dle-import-worldbook.png)

**Usage:** `/dle-import` opens a popup where you paste your WI JSON and choose a target folder.

**What it converts:**
- `key` to `keys` (primary keywords)
- `keysecondary` to `refine_keys`
- `order` to `priority`
- `position` to `position` (mapped to before/after/in_chat)
- `depth` to `depth`
- `probability` to `probability` (scaled from 0-100 to 0.0-1.0)
- `constant` to `#lorebook-always` tag
- `comment` to entry title

**When to use:** Migrating from SillyTavern's built-in World Info to an Obsidian vault. Import your existing lorebook, then enhance the entries with summaries, wikilinks, and the additional frontmatter fields DLE supports.
