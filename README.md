# DeepLore Enhanced - AI-Powered Obsidian Vault Lorebook for SillyTavern

> **Looking for a supported version?** You probably want **[DeepLore](https://github.com/pixelnull/sillytavern-DeepLore)** instead. DeepLore is the stable, general-purpose version with keyword-based lorebook matching. It's what I'd recommend for most people.

> **Personal project -- not for general use.** This fork exists for my own setup and workflow. I develop and test it against my specific stack. If something breaks for you but works for me, I won't be able to help -- I can't fix bugs I can't replicate. No support is offered. If you don't need AI-powered search, use [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore).

> **Do NOT run this alongside DeepLore.** Running both DeepLore and DeepLore Enhanced at the same time is not supported and will cause conflicts. Disable or uninstall DeepLore before using this extension. If you run into issues with both installed, the fix is to pick one and remove the other.

DeepLore Enhanced is a fork of [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) that adds **AI-powered semantic search** on top of the existing keyword matching system. It uses Claude Haiku (via [claude-code-proxy](https://github.com/horselock/claude-code-proxy)) to find vault entries that are *contextually relevant* to the conversation, even when no exact keywords match.

## What's New (vs DeepLore)

- **AI-powered entry selection** -- Claude Haiku reads your recent chat context alongside a compact manifest of vault entries and selects which ones are relevant. Catches thematic connections that keyword matching misses entirely.
- **Two-stage pipeline** -- Keywords run first as a broad pre-filter, then only keyword-matched candidates are sent to Haiku for smart selection. Reduces token cost and improves relevance. An "AI Only" mode is also available for full-vault evaluation.
- **Smart caching** -- AI results are cached by chat context hash. Regenerations and swipes reuse cached results without making another API call.
- **Configurable system prompt** -- Customize how the AI evaluates relevance for your specific world.
- **Session usage tracking** -- See how many AI calls, cache hits, and estimated tokens used in the settings panel.
- **Graceful degradation** -- If the proxy is down or slow, generation proceeds with keyword-only results. AI search has a configurable timeout and never blocks your chat.
- **Context Cartographer** -- Click the book icon on any AI message to see which vault entries were injected, why they matched, their priority, and token cost. With an Obsidian vault name configured, entries link directly into Obsidian.
- **Session Scribe** -- Automatically summarizes roleplay sessions and writes them to your Obsidian vault as timestamped markdown notes. Triggers after every N AI messages or on demand via `/dle-scribe`.
- **Conditional Gating** -- Entries can declare dependencies (`requires`) and blockers (`excludes`) on other entries. Cascading dependencies resolve automatically.
- **Per-Entry Injection Position** -- Override the global injection position, depth, and role on a per-entry basis via frontmatter. Entries are grouped and injected separately.
- **Vault Change Detection** -- Detects added, removed, and modified entries when the index rebuilds. Optional toast notifications and configurable auto-sync polling.

## Prerequisites

This is a fairly specific stack. You need all of these:

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.12.0+)
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled
- [claude-code-proxy](https://github.com/horselock/claude-code-proxy) running locally (for AI search features)
- A Claude subscription that gives you access to Claude Haiku through the proxy
- Server plugins enabled in SillyTavern (`enableServerPlugins: true` in `config.yaml`)

If you only want keyword matching (no AI search), you can skip the claude-code-proxy prerequisite and just leave AI Search disabled in settings.

## Installation

### Step 1: Install the client extension

Use SillyTavern's built-in extension installer (recommended):

1. Open SillyTavern
2. Go to **Extensions** panel > **Install Extension**
3. Paste this URL: `https://github.com/pixelnull/sillytavern-DeepLore-Enhanced`
4. Click **Install**

Or install manually with git:

```bash
cd SillyTavern/data/default-user/extensions
git clone https://github.com/pixelnull/sillytavern-DeepLore-Enhanced.git
```

### Step 2: Install the server plugin

**Option A: Use the installer script (recommended)**

Run the installer from the extension directory:

- **Windows:** Double-click `install-server.bat` or run it from the command line
- **Linux/Mac:** Run `./install-server.sh`

If the extension isn't installed inside SillyTavern's directory, pass the SillyTavern root path as an argument:

```bash
./install-server.sh /path/to/SillyTavern
```

**Option B: Manual copy**

1. Find the `server` folder at `SillyTavern/public/scripts/extensions/third-party/sillytavern-DeepLore-Enhanced/server`
2. Copy it into `SillyTavern/plugins/`
3. Rename it to `deeplore-enhanced`

The result should be: `SillyTavern/plugins/deeplore-enhanced/index.js`

### Step 3: Enable server plugins

In your SillyTavern `config.yaml`, set:

```yaml
enableServerPlugins: true
```

### Step 4: Restart SillyTavern

Restart the SillyTavern server so it picks up the new plugin, then refresh the browser.

## Setup

### Obsidian Connection

1. In Obsidian, install and enable the **Local REST API** community plugin
2. Note the **API port** (default: 27123) and copy the **API key** from Obsidian Settings > Local REST API
3. In SillyTavern, go to **Extensions** > **DeepLore Enhanced**
4. Enter the port and API key, then click **Test Connection**
5. Check **Enable DeepLore Enhanced**
6. Click **Refresh Index** to pull your vault entries

### AI Search Setup

1. Install and run [claude-code-proxy](https://github.com/horselock/claude-code-proxy) (defaults to `http://localhost:42069`)
2. In the DeepLore Enhanced settings, scroll to the **AI Search** section
3. Check **Enable AI Search**
4. Set the **Proxy URL** (default: `http://localhost:42069`)
5. Set the **Model** (default: `claude-haiku-4-5-20251001`)
6. Click **Test AI Search** to verify the connection

## Writing Lorebook Notes

Tag any Obsidian note with `#lorebook` (configurable) and add a `keys` field in the YAML frontmatter:

```markdown
---
tags:
  - lorebook
keys:
  - Eris
  - goddess of discord
priority: 10
---

# Eris

Eris is the goddess of discord and strife. She carries a golden apple
inscribed "To the Fairest" which she uses to sow chaos among mortals
and gods alike.
```

### Frontmatter Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tags` | array | (required) | Must include your lorebook tag (default: `lorebook`) |
| `keys` | array | `[]` | Keywords that trigger this entry when found in chat |
| `priority` | number | `100` | Sort order (lower = injected first) |
| `constant` | boolean | `false` | Always inject regardless of keywords |
| `enabled` | boolean | `true` | Set to `false` to skip this note |
| `scanDepth` | number | (global) | Override the global scan depth for this entry |
| `excludeRecursion` | boolean | `false` | Don't scan this entry's content during recursive matching |
| `requires` | array | `[]` | Entry titles that must ALL be matched for this entry to activate |
| `excludes` | array | `[]` | Entry titles that, if ANY are matched, block this entry |
| `position` | string | (global) | Injection position override: `before`, `after`, or `in_chat` |
| `depth` | number | (global) | Injection depth override (for `in_chat` position) |
| `role` | string | (global) | Message role override: `system`, `user`, or `assistant` |
| `summary` | string | `""` | AI selection summary — a short description (up to 600 chars) used in the manifest to help Haiku decide relevance. Not injected into the writing AI. |

### Special Tags

- **`#lorebook`** -- Marks a note as a lorebook entry (configurable in settings)
- **`#lorebook-always`** -- Forces the note to always be injected, like `constant: true`
- **`#lorebook-never`** -- Prevents the note from ever being injected, even if keywords match

## How AI Search Works

**Two-Stage mode** (default):
1. On each generation, **keyword matching** runs first against recent chat messages, producing a set of candidate entries.
2. A **compact manifest** is built from those candidates only -- entry name, token cost, linked entries, and a summary per entry (from the `summary` frontmatter field, or truncated content as fallback).
3. The candidate manifest and recent chat are sent to Claude Haiku via the proxy.
4. Haiku returns a JSON array selecting the most relevant entries from the candidates. This is the final selection (plus constants).
5. The selected set goes through gating (requires/excludes), budget/template formatting, and gets injected into the prompt.
6. **Caching:** The chat context + candidate manifest are hashed. Regenerations and swipes reuse cached results without another API call.

**AI Only mode:**
- Skips keyword matching entirely. A manifest of all non-constant vault entries is sent to Haiku for evaluation. More thorough but uses more tokens.

**Error fallback:** If the AI proxy is down or returns an error, the pipeline falls back to keyword-only results (two-stage mode) or the full vault sorted by priority (AI-only mode). If the AI intentionally returns an empty selection, only constant entries are injected.

### Conditional Gating Example

```markdown
---
tags:
  - lorebook
keys:
  - secret ritual
requires:
  - Eris
  - Dark Council
excludes:
  - Draft Notes
---

# The Forbidden Ritual

This entry only injects when both "Eris" and "Dark Council" entries are also
matched, and is blocked if "Draft Notes" is matched. Cascading works: if Eris
gets removed by its own gating rules, this entry is removed too.
```

### Per-Entry Injection Position Example

```markdown
---
tags:
  - lorebook
keys:
  - world setting
position: before
---

# World Setting

This entry injects before the system prompt instead of the global default.
```

```markdown
---
tags:
  - lorebook
keys:
  - dialogue hint
position: in_chat
depth: 1
role: user
---

# Dialogue Style

This entry injects as a user message at depth 1 in the chat history.
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/dle-refresh` | Force rebuild the vault index cache |
| `/dle-status` | Show connection info, entry counts, AI search stats, and cache status |
| `/dle-review [question]` | Send all entries to the AI for review. Optionally provide a custom question. |
| `/dle-scribe [topic]` | Write a session summary on demand. Optionally provide a focus topic. |

## Settings Reference

### Connection
- **Obsidian API Port** -- Port for the Local REST API plugin (default: 27123)
- **API Key** -- Bearer token from Obsidian's Local REST API settings

### Vault Settings
- **Lorebook Tag** -- Tag that identifies lorebook notes (default: `lorebook`)
- **Always-Send Tag** -- Tag for entries that always inject (default: `lorebook-always`)
- **Never-Insert Tag** -- Tag for entries that never inject (default: `lorebook-never`)
- **Scan Depth** -- How many recent messages to scan for keywords (default: 4)
- **Max Entries / Unlimited** -- Cap on injected entries per generation
- **Token Budget / Unlimited** -- Cap on total injected tokens per generation

### Matching
- **Case Sensitive** -- Whether keyword matching respects case
- **Match Whole Words** -- Use word boundaries so "war" won't match "warning"
- **Recursive Scanning** -- Scan matched entry content for more keyword triggers
- **Max Recursion Steps** -- Limit on recursive scan passes (default: 3)

### AI Search
- **Enable AI Search** -- Toggle AI-powered semantic search
- **AI Search Mode** -- "Two-Stage (keywords → AI)" pre-filters with keywords first, then AI picks from candidates. "AI Only (full vault)" sends the entire manifest to Haiku directly.
- **Proxy URL** -- URL of the claude-code-proxy (default: `http://localhost:42069`)
- **Model** -- Claude model to use (default: `claude-haiku-4-5-20251001`)
- **Max Response Tokens** -- Token limit for the AI response (default: 1024). Keep low -- we only need a JSON array of titles.
- **Timeout (ms)** -- How long to wait for the AI before falling back to keyword-only results (default: 10000)
- **AI Scan Depth** -- How many recent messages to send as context to the AI (default: 4). Can differ from keyword scan depth.
- **Manifest Summary Length** -- Maximum characters for entry summaries in the AI manifest (default: 600). Only applies to entries without a `summary` frontmatter field (which are used as-is). Higher gives more context but costs more tokens.
- **System Prompt Override** -- Custom system prompt for the AI. Leave empty for the built-in default. Supports `{{maxEntries}}` placeholder. `"You are Claude Code."` is always prepended (proxy requirement).

### Injection
- **Injection Template** -- Format string with `{{title}}` and `{{content}}` macros
- **Injection Position** -- Where in the prompt to insert lore (before/after system prompt, or in-chat at depth). Entries can override via frontmatter.
- **Injection Depth** -- Chat depth for in-chat injection. Entries can override via frontmatter.
- **Injection Role** -- Message role (system/user/assistant). Entries can override via frontmatter.
- **Allow World Info Scan** -- Let ST's World Info system scan injected lore
- **Show Lore Sources Button** -- Add a book icon to AI messages showing which entries were injected (Context Cartographer)

### Session Scribe
- **Enable Session Scribe** -- Auto-summarize sessions to your Obsidian vault
- **Auto-Scribe Interval** -- Number of AI messages between automatic summaries (default: 5)
- **Session Folder** -- Vault folder for session summaries (default: `Sessions`)
- **Custom Summary Prompt** -- Override the default session summary prompt

### Index & Debug
- **Cache TTL** -- How long (seconds) to cache the vault index before re-fetching (default: 300)
- **Review Response Tokens** -- Token limit for `/dle-review` responses (0 = auto)
- **Auto-Sync Interval** -- Seconds between automatic vault re-checks (0 = disabled). Detects changes without manual refresh.
- **Show Sync Change Toasts** -- Show toast notifications when vault changes are detected
- **Debug Mode** -- Log match details to browser console (F12). Shows keyword matches, AI search results, gating, token counts.

## License

MIT
