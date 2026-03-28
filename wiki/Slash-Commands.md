# Slash Commands

DeepLore Enhanced registers several slash commands in SillyTavern. Type them in the chat input box.

## Commands

### `/dle-help`
Show a quick-reference list of all DeepLore Enhanced slash commands with brief descriptions. Organized by category (diagnostics, AI features, per-chat overrides, contextual gating).

---

### `/dle-refresh`
Force rebuild the vault index cache. Re-fetches all entries from Obsidian regardless of Cache TTL.

**When to use:** After editing entries in Obsidian and you don't want to wait for the cache to expire or auto-sync to detect changes.

---

### `/dle-status`
Show connection info, entry counts, AI search stats, and cache status in a popup.

**Shows:**
- Obsidian connection status and configured vaults
- Number of indexed entries (total, constants, seeds, bootstrap, estimated tokens)
- Budget and max entries configuration
- AI search configuration and session stats (calls, cache hits, tokens)
- Cache age and TTL
- Auto-sync status

---

### `/dle-why` (alias: `/dle-context`)
Run the full pipeline without generating a message and show what would be injected right now.

**When to use:** Preview which entries would match the current chat state. Runs keyword matching, AI search (if enabled), gating, and budget filtering — the full pipeline — and displays the results in a Context Cartographer popup.

**Notes:**
- If AI search is enabled, this command will make a real API call and use tokens. A confirmation dialog is shown first.
- `/dle-context` is a backwards-compatible alias.

---

### `/dle-browse`
Open a searchable, filterable popup of all indexed entries.

**When to use:** Quickly review your vault contents without switching to Obsidian. Browse entry titles, keywords, priorities, and token sizes.

---

### `/dle-notebook`
Open the Author's Notebook editor for the current chat.

**When to use:** Edit the persistent per-chat scratchpad. Content is injected into every generation when Author's Notebook is enabled. See [[Features#Author's Notebook]].

---

### `/dle-review [question]`
Send all vault entries to the AI for review. Posts the vault as a user message and generates an AI response.

**Usage:**
- `/dle-review` General review of all entries
- `/dle-review Are there any contradictions between character backstories?` Ask a specific question

**Notes:**
- Sends the entire vault as a user message and triggers a normal generation
- Response token limit controlled by the "Review Response Tokens" setting (0 = auto)
- Confirms before sending (shows entry count and estimated tokens)

---

### `/dle-scribe [focus]`
Write a session summary note to your Obsidian vault on demand.

**Usage:**
- `/dle-scribe` Summarize the full session
- `/dle-scribe What happened with the sword?` Summarize with a specific focus topic

**Notes:**
- Works on-demand without needing Session Scribe enabled in settings
- Writes a timestamped markdown note to the configured Session Folder
- Uses the configured Scribe connection (SillyTavern, Connection Profile, or Custom Proxy)
- Auto-scribe also triggers every N messages when enabled (tracks actual chat position)

---

### `/dle-scribe-history`
Show all session notes from the configured scribe folder in a browsable popup.

**Shows:**
- All notes sorted by date (newest first)
- Character name and timestamp for each note
- Expandable content preview — click to show the full note

**Notes:**
- Requires a scribe folder to be configured in settings
- Fetches notes directly from Obsidian's Local REST API

---

### `/dle-newlore` (alias: `/dle-suggest`)
AI analyzes the current chat for characters, locations, items, concepts, or events that are mentioned but don't have an existing lorebook entry, then suggests new entries.

**Shows:**
- Popup with suggested entries (title, type, keywords, summary, content preview)
- Accept button writes the entry to Obsidian with proper frontmatter
- Reject button dismisses the suggestion

**Notes:**
- Works on-demand without needing Auto Lorebook enabled
- Filters out entries that already exist (case-insensitive)
- Uses the Auto Lorebook connection settings (SillyTavern, Profile, or Proxy)
- `/dle-suggest` is a backwards-compatible alias for this command

---

### `/dle-optimize-keys <entry name>`
AI analyzes the specified entry and suggests better keywords.

**Usage:**
- `/dle-optimize-keys Valen Ashwick` Optimize keywords for the "Valen Ashwick" entry

**Notes:**
- Considers the entry's content, summary, and current keywords
- Shows suggestions in a popup — you review and apply changes in Obsidian
- Uses the AI Search connection settings

---

### `/dle-simulate`
Replay the current chat history step-by-step, showing which entries activate and deactivate at each message.

**Shows:**
- Timeline of entry activation across the conversation
- Which entries turn on/off at each message boundary

**When to use:** Understand how your keywords and pipeline behave across an entire conversation. Helps identify entries that trigger too early, too late, or not at all.

---

### `/dle-graph`
Visualize entry relationships as an interactive force-directed graph.

**Shows:**
- Nodes for each entry, connected by wikilinks, requires/excludes, and cascade links
- Interactive — drag nodes, zoom, and pan

**When to use:** Explore the relationship structure of your vault. Identify clusters, orphaned entries, and dependency chains.

---

### `/dle-analytics`
Show entry usage analytics in a popup. Displays a table of all entries sorted by injection count.

**Shows:**
- Entry name, match count, injection count, last used timestamp
- "Never Injected" section for dead entry detection
- Helps identify entries that never trigger (may need better keywords or summaries)

**Notes:**
- Analytics persist in SillyTavern settings across sessions
- Resets when you clear settings or reinstall

---

### `/dle-health`
Run 30+ health checks on vault entries and settings. Shows results grouped by category in a popup.

**Check categories:**
- Multi-vault configuration
- Settings validation (scan depth, AI mode, proxy URL, budget)
- Entry config (duplicate titles, empty keys/content, orphaned references, oversized entries)
- Gating (circular requires, unresolved links, conflicting overrides)
- AI Search (missing summaries)
- Keywords (short keywords, duplicates across entries)
- Entry behavior (cooldown on constants, warmup/probability issues)

**When to use:** After adding or modifying entries, or if entries aren't matching as expected. See [[Features#Entry Health Check]].

---

### `/dle-inspect`
Show a detailed trace of the last generation pipeline in a popup.

**Shows:**
- Pipeline mode (two-stage, ai-only, keywords-only)
- Index size and bootstrap status
- Keyword-matched entries with the specific keywords that triggered them
- AI-selected entries with confidence level and selection reason
- Whether fallback was used (and why)

**When to use:** To debug why certain entries were or weren't injected in the last generation. See [[Pipeline]] for how the pipeline works.

---

### `/dle-pin <entry name>`
Pin an entry to always inject in the current chat, regardless of keywords or AI selection. Stored in `chat_metadata.deeplore_pins`.

---

### `/dle-unpin <entry name>`
Remove a pin from the current chat.

---

### `/dle-block <entry name>`
Block an entry from injecting in the current chat. Stored in `chat_metadata.deeplore_blocks`.

---

### `/dle-unblock <entry name>`
Remove a block from the current chat.

---

### `/dle-pins`
Show all pinned and blocked entries for the current chat. See [[Features#Per-Chat Pin/Block]].

---

### `/dle-set-field <name> [value]`
Set any custom gating field (e.g., `/dle-set-field weather stormy`). Works with both built-in and user-defined fields. **With no argument for value:** opens a browse-and-select popup showing all values found in the vault for that field.

---

### `/dle-clear-field <name>`
Clear a custom gating field, removing it from the active context (e.g., `/dle-clear-field weather`). Works with both built-in and user-defined fields.

---

### `/dle-set-era [era]`
Alias for `/dle-set-field era [value]`. Set the active era for contextual gating (e.g., `/dle-set-era pre-war`). **With no argument:** opens a browse-and-select popup showing all era values found in the vault, with entry counts for each.

---

### `/dle-set-location [location]`
Alias for `/dle-set-field location [value]`. Set the active location for contextual gating (e.g., `/dle-set-location The Docks`). **With no argument:** opens a browse-and-select popup showing all location values in the vault with entry counts.

---

### `/dle-set-scene [scene type]`
Alias for `/dle-set-field scene_type [value]`. Set the active scene type for contextual gating (e.g., `/dle-set-scene combat`). **With no argument:** opens a browse-and-select popup showing all scene type values in the vault with entry counts.

---

### `/dle-set-characters <names>`
Alias for `/dle-set-field character_present [value]`. Set the present characters for contextual gating (e.g., `/dle-set-characters Valen, Sera`). Comma-separated list. Clear with no argument.

---

### `/dle-context-state`
Show the current contextual gating state, including all active gating fields (both built-in and custom). See [[Features#Contextual Gating]].

---

### `/dle-setup`
Run the first-time setup wizard. Walks through Obsidian vault connection, tag configuration, and search mode selection. AI search connection (profile or proxy) must be configured separately in the settings panel. See [[Installation]].

---

### `/dle-summarize`
Generate AI summaries for entries that lack a `summary` field. Summaries are written directly to each entry's frontmatter in Obsidian. See [[Features#Auto-Summary Generation]].

---

### `/dle-import`
Import SillyTavern World Info JSON into the vault. Opens a popup where you paste your WI JSON and choose a target folder. Handles WI exports, V2 character cards, and entry arrays. See [[Features#ST Lorebook Import Bridge]].

## Quick Reference

| Command | Description |
|---------|-------------|
| `/dle-help` | Quick reference of all commands |
| `/dle-refresh` | Force re-index vault |
| `/dle-status` | Show connection and index status |
| `/dle-why` (`/dle-context`) | Preview what would be injected now |
| `/dle-browse` | Browse all indexed entries |
| `/dle-notebook` | Open Author's Notebook editor |
| `/dle-review [question]` | Send vault to AI for review |
| `/dle-scribe [focus]` | Write session note to Obsidian |
| `/dle-scribe-history` | View all session notes |
| `/dle-newlore` (`/dle-suggest`) | AI suggests new lorebook entries |
| `/dle-optimize-keys <name>` | AI optimizes entry keywords |
| `/dle-simulate` | Replay chat showing entry activation |
| `/dle-graph` | Visualize entry relationships |
| `/dle-analytics` | Entry usage statistics |
| `/dle-health` | Audit entries for issues (30+ checks) |
| `/dle-inspect` | Show last pipeline trace |
| `/dle-pin <name>` | Pin entry to always inject in this chat |
| `/dle-unpin <name>` | Remove a pin |
| `/dle-block <name>` | Block entry from injecting in this chat |
| `/dle-unblock <name>` | Remove a block |
| `/dle-pins` | Show all pins and blocks |
| `/dle-set-field <name> [value]` | Set any custom gating field |
| `/dle-clear-field <name>` | Clear a custom gating field |
| `/dle-set-era <era>` | Alias: set active era |
| `/dle-set-location <loc>` | Alias: set active location |
| `/dle-set-scene <type>` | Alias: set active scene type |
| `/dle-set-characters <names>` | Alias: set present characters |
| `/dle-context-state` | Show all active gating fields |
| `/dle-setup` | Run setup wizard |
| `/dle-summarize` | Generate AI summaries for entries |
| `/dle-import` | Import ST World Info JSON |
