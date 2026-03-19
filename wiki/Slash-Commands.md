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
- Works on-demand without needing Session Scribe enabled in settings
- Writes a timestamped markdown note to the configured Session Folder
- Uses the configured Scribe connection (SillyTavern, Connection Profile, or Custom Proxy)
- Auto-scribe also triggers every N messages when enabled (tracks actual chat position)

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

## Quick Reference

| Command | Description |
|---------|-------------|
| `/dle-refresh` | Force re-index vault |
| `/dle-status` | Show connection and index status |
| `/dle-review [question]` | Send vault to AI for review |
| `/dle-scribe [focus]` | Write session note to Obsidian |
| `/dle-analytics` | Entry usage statistics |
| `/dle-health` | Audit entries for issues |
| `/dle-inspect` | Show last pipeline trace |
