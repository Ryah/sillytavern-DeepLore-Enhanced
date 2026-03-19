# Settings Reference

Complete reference for every DeepLore Enhanced setting, organized by section.

## Connection

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Enable DeepLore Enhanced** | Off | Toggle | Master toggle. When disabled, no entries are injected. |
| **Obsidian API Port** | `27123` | 1-65535 | Port for the Obsidian Local REST API plugin. Found in Obsidian Settings > Local REST API. |
| **API Key** | (none) | Text | Bearer token from Obsidian's Local REST API settings. Required for authenticated access. |

**Test Connection** button verifies the Obsidian connection using the configured port and API key.

## Vault Tags

| Setting | Default | Description |
|---------|---------|-------------|
| **Lorebook Tag** | `lorebook` | Obsidian tag (without `#`) that marks a note as a lorebook entry. Only notes with this tag are indexed. |
| **Always-Send Tag** | `lorebook-always` | Tag that forces a note to always be injected regardless of keyword matches. Like `constant: true`. |
| **Never-Insert Tag** | `lorebook-never` | Tag that prevents a note from ever being injected, even if keywords match. Good for drafts or WIP notes. |
| **Seed Tag** | `lorebook-seed` | Tag for entries whose content is sent to the AI as story context on new chats. Not injected; only informs AI selection. See [[Features#New Chat Features]]. |
| **Bootstrap Tag** | `lorebook-bootstrap` | Tag for entries that force-inject when chat is short, then become regular entries. See [[Features#New Chat Features]]. |
| **New Chat Threshold** | `3` | 1-20. Message count below which seed context is sent and bootstrap entries are force-injected. |

## Matching & Budget

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Scan Depth** | `4` | 0-100 | Number of recent chat messages to scan for keyword matches. Set to 0 to disable keyword matching (AI search only). |
| **Case Sensitive** | Off | Toggle | When on, keyword matching respects case (`Eris` won't match `eris`). |
| **Match Whole Words** | Off | Toggle | When on, keywords use word boundaries (`war` won't match `warning`). |
| **Active Character Boost** | Off | Toggle | Auto-match the active character's vault entry by name or keyword, even if not mentioned in chat. See [[Features#Active Character Boost]]. |
| **Recursive Scanning** | Off | Toggle | After initial matches, scan matched entries' content for keywords that trigger more entries. |
| **Max Recursion Steps** | `3` | 1-10 | Maximum recursive scan passes. Each pass scans newly matched entries for more triggers. |
| **Re-injection Cooldown** | `0` | 0-50 | Skip re-injecting an entry for N generations after last injection. 0 = disabled. Constants are exempt. |
| **Unlimited Entries** | On | Toggle | Remove the cap on how many entries can be injected per generation. |
| **Max Entries** | `10` | 1-100 | Maximum entries to inject (when Unlimited Entries is off). Sorted by priority. |
| **Unlimited Token Budget** | On | Toggle | Remove the token budget cap. A warning toast appears if injected lore exceeds 20% of context. |
| **Token Budget** | `2048` | 100-100000 | Maximum total tokens to inject (when Unlimited Token Budget is off). Entries added in priority order until budget is reached. |

## Injection

| Setting | Default | Description |
|---------|---------|-------------|
| **Injection Template** | `<{{title}}>\n{{content}}\n</{{title}}>` | Format for each injected entry. Use `{{title}}` for entry name and `{{content}}` for note body. |
| **Injection Position** | In-chat | Where to inject lore. Options: Before Main Prompt/Story String, After Main Prompt/Story String, or In-chat @ Depth. |
| **Injection Depth** | `4` | 0-9999. Chat depth for in-chat injection (0 = last message). |
| **Injection Role** | System | Message role for in-chat injection: System, User, or Assistant. |
| **Allow World Info Scan** | Off | Let SillyTavern's built-in World Info system scan injected lore for WI keyword matches. Enables cross-system triggering. |

> Entries can override position, depth, and role via frontmatter. See [[Writing Vault Entries]].

## Context Cartographer

| Setting | Default | Description |
|---------|---------|-------------|
| **Show Lore Sources Button** | On | Add a book icon to AI messages showing which entries were injected and why. See [[Features#Context Cartographer]]. |
| **Obsidian Vault Name** | (none) | Your vault name for deep links. When set, entry names in the lore sources popup link directly into Obsidian. Must match the vault name in Obsidian's title bar. |

## AI Search

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Enable AI Search** | Off | Toggle | Toggle AI-powered semantic search. Makes one API call per generation (cached on regenerations). |
| **Connection** | Profile | Toggle | "Connection Profile" uses a saved ST profile (recommended). "Custom Proxy" uses a separate proxy server. |
| **Connection Profile** | (none) | Dropdown | (Profile mode) Select a saved Connection Manager profile. Any provider works. |
| **Proxy URL** | `http://localhost:42069` | Text | (Proxy mode) URL of the claude-code-proxy or compatible endpoint. Must expose `/v1/messages`. |
| **Model Override** | (none) | Text | Optional model override. In profile mode, leave empty to use the profile's model. In proxy mode, specify the model name. |
| **Max Response Tokens** | `1024` | 64-4096 | Token limit for the AI response. Keep low; only a JSON array is needed. |
| **Timeout (ms)** | `10000` | 1000-30000 | How long to wait for the AI before falling back to keyword-only results. |
| **AI Search Mode** | Two-Stage | Toggle | "Two-Stage (keywords → AI)" pre-filters with keywords. "AI Only (full vault)" sends entire manifest. See [[AI Search]]. |
| **AI Scan Depth** | `4` | 1-100 | Number of recent messages to send as context to the AI. Can differ from keyword scan depth. |
| **Manifest Summary Length** | `600` | 100-1000 | Max characters for entry summaries in the manifest. Only for entries without a `summary` field. |
| **System Prompt Override** | (none) | Text | Custom system prompt for AI selection. Leave empty for default. Supports `{{maxEntries}}` placeholder. |

**Test AI Search** button tests the AI connection. **Preview AI Prompt** button shows the full prompt that would be sent.

**AI Stats** shows session usage: AI calls, cache hits, estimated input/output tokens.

## Session Scribe

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Enable Session Scribe** | Off | Toggle | Auto-summarize sessions to your Obsidian vault. See [[Features#Session Scribe]]. |
| **Auto-Scribe Every N Messages** | `5` | 1-50 | Number of new messages (tracked by chat position) between automatic summaries. |
| **Session Folder** | `Sessions` | Text | Vault folder where session notes are saved. Created if it doesn't exist. |
| **Connection** | SillyTavern | Radio | `SillyTavern` (active connection), `Connection Profile` (saved profile), or `Custom Proxy`. |
| **Connection Profile** | (none) | Select | Connection Manager profile for summaries. Only shown in Profile mode. |
| **Proxy URL** | `http://localhost:42069` | Text | Proxy server URL. Only shown in Proxy mode. |
| **Model Override** | (none) | Text | Override the model used for summaries. Only shown in Profile/Proxy modes. |
| **Max Response Tokens** | `1024` | 256-4096 | Maximum tokens for the summary response. Only shown in Profile/Proxy modes. |
| **Timeout (ms)** | `30000` | 5000-60000 | Request timeout for summary generation. Only shown in Profile/Proxy modes. |
| **Messages to Include** | `20` | 5-100 | Number of recent chat messages included as context for the summary. |
| **Custom Summary Prompt** | (none) | Text | Override the default summary prompt. Default covers events, character dynamics, revelations, and state changes. |

## Index & Cache

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Cache TTL (seconds)** | `300` | 0-86400 | How long to cache the vault index before re-fetching. 0 = always fetch fresh (slower). |
| **Auto-Sync Interval** | `0` | 0-3600 | Seconds between automatic vault re-checks. 0 = disabled. See [[Features#Vault Change Detection & Auto-Sync]]. |
| **Show Sync Change Toasts** | On | Toggle | Show toast notifications when vault changes are detected during index refresh. |

**Refresh Index** button clears the cache and re-fetches all entries. **Test Match** button simulates a generation to show which entries would match.

## Advanced

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Review Response Tokens** | `0` | 0-100000 | Token limit for `/dle-review` responses. 0 = auto (uses your connection profile's Max Response Length). |
| **Debug Mode** | Off | Toggle | Log detailed match info to browser console (F12). Shows keyword matches, AI results, gating, token counts, injection details. |
