# DeepLore Enhanced - AI-Powered Obsidian Vault Lorebook for SillyTavern

> **Looking for a supported version?** You probably want **[DeepLore](https://github.com/pixelnull/sillytavern-DeepLore)** instead. DeepLore is the stable, general-purpose version with keyword-based lorebook matching. It's what I'd recommend for most people.

> **Personal project -- not for general use.** This fork exists for my own setup and workflow. I develop and test it against my specific stack. If something breaks for you but works for me, I won't be able to help -- I can't fix bugs I can't replicate. No support is offered. If you don't need AI-powered search, use [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore).

> **Do NOT run this alongside DeepLore.** Running both DeepLore and DeepLore Enhanced at the same time is not supported and will cause conflicts. Disable or uninstall DeepLore before using this extension. If you run into issues with both installed, the fix is to pick one and remove the other.

DeepLore Enhanced is a fork of [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) that adds **AI-powered semantic search** on top of the existing keyword matching system. It uses any AI provider configured in SillyTavern's Connection Manager (or a custom proxy like [claude-code-proxy](https://github.com/horselock/claude-code-proxy)) to find vault entries that are *contextually relevant* to the conversation, even when no exact keywords match.

> **Upgrading?** Make sure to install the new server `index.js`. New since 0.12: Connection Profile support for AI search (no proxy needed). See the [changelog](CHANGELOG.md) for details.

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
- **Cooldown & Warmup Tags** -- Per-entry `cooldown` skips injection for N generations after triggering. Per-entry `warmup` requires N keyword occurrences before first trigger.
- **Re-injection Cooldown** -- Global setting to skip re-injecting entries for N generations after last injection, saving context.
- **Active Character Boost** -- Optionally auto-match the active character's vault entry by name, ensuring their lore is always available when they're in the conversation.
- **Pipeline Inspector** -- View a detailed trace of the last generation pipeline with `/dle-inspect`: keyword matches with trigger keywords, AI selections with confidence and reasons, fallback status, and mode info.
- **Entry Analytics** -- Track how often each entry is matched and injected. View with `/dle-analytics`.
- **Entry Health Check** -- Audit entries for common issues (empty keys, orphaned requires/excludes, oversized, duplicate keywords, missing summaries) with `/dle-health`.

## Prerequisites

This is a fairly specific stack. You need all of these:

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.12.0+)
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled
- Server plugins enabled in SillyTavern (`enableServerPlugins: true` in `config.yaml`)
- **For AI search (one of):**
  - A saved **Connection Manager profile** in SillyTavern (any provider: Anthropic, OpenAI, OpenRouter, etc.) — **recommended, no extra setup**
  - OR [claude-code-proxy](https://github.com/horselock/claude-code-proxy) running locally (legacy/advanced)

If you only want keyword matching (no AI search), you can skip the AI search prerequisites and just leave AI Search disabled in settings.

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

**Option A: Connection Profile (recommended)**

1. In SillyTavern, set up an API connection (Anthropic, OpenAI, OpenRouter, etc.) and save it as a **Connection Manager profile**
2. In the DeepLore Enhanced settings, scroll to the **AI Search** section
3. Check **Enable AI Search**
4. Select **Connection Profile** mode (default)
5. Choose your saved profile from the dropdown
6. Optionally set a **Model Override** (leave empty to use the profile's model)
7. Click **Test AI Search** to verify the connection

**Option B: Custom Proxy (claude-code-proxy)**

1. Install and run [claude-code-proxy](https://github.com/horselock/claude-code-proxy) (defaults to `http://localhost:42069`)
2. In the DeepLore Enhanced settings, scroll to the **AI Search** section
3. Check **Enable AI Search**
4. Select **Custom Proxy** mode
5. Set the **Proxy URL** (default: `http://localhost:42069`)
6. Set the **Model Override** (e.g. `claude-haiku-4-5-20251001`)
7. Click **Test AI Search** to verify the connection

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
summary: "Goddess of discord and strife. Select when chaos, golden apple, divine rivalry, or conflicts among gods come up."
---

# Eris

Eris is the goddess of discord and strife. She carries a golden apple
inscribed "To the Fairest" which she uses to sow chaos among mortals
and gods alike.
```

The `summary` field is optional but recommended when AI Search is enabled. It tells Haiku *when* to select this entry without sending the full content. Write it for the selection AI, not the writing AI — focus on what the entry is and what situations should trigger it. Up to 600 characters. Entries without a `summary` fall back to truncated content.

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
| `cooldown` | number | (none) | After triggering, skip this entry for N generations |
| `warmup` | number | (none) | Require keyword to appear N times before triggering (must be >1) |

### Special Tags

- **`#lorebook`** -- Marks a note as a lorebook entry (configurable in settings)
- **`#lorebook-always`** -- Forces the note to always be injected, like `constant: true`
- **`#lorebook-never`** -- Prevents the note from ever being injected, even if keywords match
- **`#lorebook-seed`** -- Entry content is sent to the AI as story context on new chats (below the New Chat Threshold), helping it make better selections. Not injected into the writing AI. See [New Chat Features](#new-chat-features).
- **`#lorebook-bootstrap`** -- Force-injects the entry when the chat is short (below the New Chat Threshold), then becomes a regular entry once the chat grows. See [New Chat Features](#new-chat-features).

## How AI Search Works

**Two-Stage mode** (default):
1. On each generation, **keyword matching** runs first against recent chat messages, producing a set of candidate entries.
2. A **compact manifest** is built from those candidates only -- entry name, token cost, linked entries, and a summary per entry (from the `summary` frontmatter field, or truncated content as fallback).
3. The candidate manifest and recent chat are sent to the AI via the configured connection (Connection Manager profile or custom proxy).
4. The AI returns a JSON array selecting the most relevant entries from the candidates. This is the final selection (plus constants).
5. The selected set goes through gating (requires/excludes), budget/template formatting, and gets injected into the prompt.
6. **Caching:** The chat context + candidate manifest are hashed. Regenerations and swipes reuse cached results without another API call.

**AI Only mode:**
- Skips keyword matching entirely. A manifest of all non-constant vault entries is sent to the AI for evaluation. More thorough but uses more tokens.

**Error fallback:** If the AI proxy is down or returns an error, the pipeline falls back to keyword-only results (two-stage mode) or the full vault sorted by priority (AI-only mode). If the AI intentionally returns an empty selection, only constant entries are injected.

## New Chat Features

On a brand new chat, the AI has very little context to work with (just 1-2 messages). Two features help bootstrap the conversation:

### Seed Entries (`#lorebook-seed`)

Tag entries like "The Story So Far" with `#lorebook-seed`. When the chat is below the **New Chat Threshold** (default: 3 messages), the content of seed entries is sent to the AI as additional story context alongside the chat. This helps the AI understand your setting and make much better entry selections, even from a single message. Seed entries are NOT injected into the writing AI's context -- they only inform the AI's decision-making.

Additionally, when seed mode is active, the AI is instructed to always fill to `maxEntries - constantCount` selections instead of being conservative.

### Bootstrap Entries (`#lorebook-bootstrap`)

Tag entries like writing instructions or foundational lore with `#lorebook-bootstrap`. When the chat is below the New Chat Threshold, these entries are force-injected (like constants). Once the chat grows past the threshold, they become regular entries managed by normal AI/keyword selection.

An entry can have both tags: its content feeds the AI (seed) AND it force-injects (bootstrap).

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
| `/dle-analytics` | Show entry usage analytics: match and injection counts per entry |
| `/dle-health` | Audit entries for common issues (empty keys, orphaned references, oversized, duplicates, missing summaries) |
| `/dle-inspect` | Show the last pipeline trace: keyword matches, AI selections, fallback status, and mode |

## Settings Reference

### Connection
- **Obsidian API Port** -- Port for the Local REST API plugin (default: 27123)
- **API Key** -- Bearer token from Obsidian's Local REST API settings

### Vault Settings
- **Lorebook Tag** -- Tag that identifies lorebook notes (default: `lorebook`)
- **Always-Send Tag** -- Tag for entries that always inject (default: `lorebook-always`)
- **Never-Insert Tag** -- Tag for entries that never inject (default: `lorebook-never`)
- **Seed Tag** -- Tag for entries whose content is sent to the AI as story context on new chats (default: `lorebook-seed`)
- **Bootstrap Tag** -- Tag for entries that force-inject when chat is short, then become regular entries (default: `lorebook-bootstrap`)
- **New Chat Threshold** -- Message count below which seed context and bootstrap injection are active (default: 3)
- **Scan Depth** -- How many recent messages to scan for keywords (default: 4)
- **Max Entries / Unlimited** -- Cap on injected entries per generation
- **Token Budget / Unlimited** -- Cap on total injected tokens per generation

### Matching
- **Case Sensitive** -- Whether keyword matching respects case
- **Match Whole Words** -- Use word boundaries so "war" won't match "warning"
- **Active Character Boost** -- Auto-match the active character's vault entry by name or keyword
- **Recursive Scanning** -- Scan matched entry content for more keyword triggers
- **Max Recursion Steps** -- Limit on recursive scan passes (default: 3)
- **Re-injection Cooldown** -- Skip re-injecting an entry for N generations after it was last injected (0 = disabled)

### AI Search
- **Enable AI Search** -- Toggle AI-powered semantic search
- **Connection** -- "Connection Profile" uses a saved SillyTavern Connection Manager profile (recommended). "Custom Proxy" uses a separate proxy server like claude-code-proxy.
- **Connection Profile** -- (Profile mode) Select a saved Connection Manager profile from the dropdown. Any provider works (Anthropic, OpenAI, OpenRouter, etc.).
- **Proxy URL** -- (Proxy mode) URL of the claude-code-proxy (default: `http://localhost:42069`)
- **Model Override** -- Optional model override. In profile mode, leave empty to use the profile's model. In proxy mode, specify the model name (e.g. `claude-haiku-4-5-20251001`).
- **AI Search Mode** -- "Two-Stage (keywords → AI)" pre-filters with keywords first, then AI picks from candidates. "AI Only (full vault)" sends the entire manifest to the AI directly.
- **Max Response Tokens** -- Token limit for the AI response (default: 1024). Keep low -- we only need a JSON array of titles.
- **Timeout (ms)** -- How long to wait for the AI before falling back to keyword-only results (default: 10000)
- **AI Scan Depth** -- How many recent messages to send as context to the AI (default: 4). Can differ from keyword scan depth.
- **Manifest Summary Length** -- Maximum characters for entry summaries in the AI manifest (default: 600). Only applies to entries without a `summary` frontmatter field (which are used as-is). Higher gives more context but costs more tokens.
- **System Prompt Override** -- Custom system prompt for the AI. Leave empty for the built-in default. Supports `{{maxEntries}}` placeholder.

### Injection
- **Injection Template** -- Format string with `{{title}}` and `{{content}}` macros
- **Injection Position** -- Where in the prompt to insert lore (before/after system prompt, or in-chat at depth). Entries can override via frontmatter.
- **Injection Depth** -- Chat depth for in-chat injection. Entries can override via frontmatter.
- **Injection Role** -- Message role (system/user/assistant). Entries can override via frontmatter.
- **Allow World Info Scan** -- Let ST's World Info system scan injected lore
- **Show Lore Sources Button** -- Add a book icon to AI messages showing which entries were injected (Context Cartographer)
- **Obsidian Vault Name** -- Your vault name for Context Cartographer deep links. When set, entry names in the lore sources popup link directly into Obsidian.

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
