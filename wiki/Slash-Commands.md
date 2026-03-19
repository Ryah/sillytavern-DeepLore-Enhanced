# Slash Commands

DeepLore Enhanced registers several slash commands in SillyTavern. Type them in the chat input box.

## Commands

### `/dle-refresh`
Force rebuild the vault index cache. Re-fetches all entries from Obsidian regardless of Cache TTL.

**When to use:** After editing entries in Obsidian and you don't want to wait for the cache to expire or auto-sync to detect changes.

---

### `/dle-status`
Show connection info, entry counts, AI search stats, and cache status in a popup.

**Shows:**
- Obsidian connection status
- Number of indexed entries (total, constants, with keys, with summaries)
- AI search configuration and session stats (calls, cache hits, tokens)
- Cache age and TTL

---

### `/dle-review [question]`
Send all vault entries to the AI for review. Opens a popup with the AI's analysis.

**Usage:**
- `/dle-review` General review of all entries
- `/dle-review Are there any contradictions between character backstories?` Ask a specific question

**Notes:**
- Uses the same AI connection as AI Search (Connection Profile or Custom Proxy)
- Response token limit controlled by the "Review Response Tokens" setting (0 = auto)
- This sends your entire vault to the AI, so it may use significant tokens

---

### `/dle-scribe [focus]`
Write a session summary note to your Obsidian vault on demand.

**Usage:**
- `/dle-scribe` Summarize the full session
- `/dle-scribe What happened with the sword?` Summarize with a specific focus topic

**Notes:**
- Requires Session Scribe to be enabled in settings
- Writes a timestamped markdown note to the configured Session Folder
- Uses your current AI connection to generate the summary
- Also triggers automatically every N AI messages when auto-scribe is enabled

---

### `/dle-analytics`
Show entry usage analytics in a popup. Displays a table of all entries sorted by injection count.

**Shows:**
- Entry name, match count, injection count
- "Never Injected" section for dead entry detection
- Helps identify entries that never trigger (may need better keywords or summaries)

**Notes:**
- Analytics are tracked per-session and persist in SillyTavern settings
- Resets when you clear settings or reinstall

---

### `/dle-health`
Audit all vault entries for common issues. Shows results in a popup.

**Checks for:**
- Empty keys on non-constant entries (won't match without keywords)
- Orphaned `requires`/`excludes` references (pointing to entries that don't exist)
- Oversized entries (>1500 tokens)
- Duplicate keywords shared across multiple entries
- Missing AI selection summaries (entries without a `summary` field)

**When to use:** After adding or modifying entries, or if entries aren't matching as expected.

---

### `/dle-inspect`
Show a detailed trace of the last generation pipeline in a popup.

**Shows:**
- Pipeline mode (two-stage, ai-only, keywords-only)
- Keyword-matched entries with the specific keywords that triggered them
- AI-selected entries with confidence level and selection reason
- Whether fallback was used (and why)
- Constants and bootstrap entries

**When to use:** To debug why certain entries were or weren't injected in the last generation. See [[Pipeline]] for how the pipeline works.

---

### `/dle-notebook`
Open the AI Notebook editor for the current chat. The notebook is a persistent scratchpad that gets injected into every generation when enabled.

**Notes:**
- Content is saved per-chat in chat metadata
- Token count is shown in the editor
- Configure injection position/depth/role in settings

---

### `/dle-browse`
Open the Entry Browser popup showing all indexed entries with search, filter, and full content preview.

**Features:**
- Search by title, keywords, or content text
- Filter by status (constant, seed, bootstrap, regular) or tag
- Click entries to expand full content, links, and metadata
- Shows priority, token count, usage analytics, and vault source

---

### `/dle-context`
Preview what lore would be injected right now without actually generating. Shows the same Context Cartographer view with token bars and injection grouping.

---

### `/dle-suggest`
Run Auto Lorebook Creation. AI analyzes the current chat for entities not in your lorebook and suggests new entries.

**Notes:**
- Each suggestion shows title, type, keywords, summary, and content
- Accept/Reject buttons per suggestion
- Accepted entries are written to Obsidian with proper frontmatter

---

### `/dle-optimize-keys [name]`
Send an entry to AI for keyword optimization. If no name is given, opens a selection popup.

**Modes:**
- Keyword-only: suggests precise, specific terms
- Two-stage: suggests broader terms (AI will refine)

---

### `/dle-simulate`
Replay chat history step-by-step showing which entries activate and deactivate at each message. Useful for understanding trigger patterns.

---

### `/dle-graph`
Visualize entry relationships as an interactive force-directed graph. Shows wiki-links, requires, excludes, and cascade connections with circular dependency detection.

**Interaction:** Drag nodes, scroll to zoom, hover for details.

---

### `/dle-scribe-history`
Fetch and display all session notes from the configured scribe folder. Notes sorted by date with expandable content.

## Quick Reference

| Command | Description |
|---------|-------------|
| `/dle-refresh` | Force re-index vault |
| `/dle-status` | Show connection and index status |
| `/dle-review [question]` | Send vault to AI for review |
| `/dle-scribe [focus]` | Write session note to Obsidian |
| `/dle-scribe-history` | View all session notes |
| `/dle-analytics` | Entry usage statistics |
| `/dle-health` | Audit entries for issues (30+ checks) |
| `/dle-inspect` | Show last pipeline trace |
| `/dle-notebook` | Open the AI Notebook editor |
| `/dle-browse` | Browse all indexed entries |
| `/dle-context` | Preview current injection state |
| `/dle-suggest` | AI suggests new lorebook entries |
| `/dle-optimize-keys [name]` | Optimize entry keywords |
| `/dle-simulate` | Replay chat activation timeline |
| `/dle-graph` | Visualize entry relationships |
