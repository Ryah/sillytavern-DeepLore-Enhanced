# Settings Reference

Complete reference for every DeepLore Enhanced setting, organized by section.

## Connection

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Enable DeepLore Enhanced** | Off | Toggle | Master toggle. When disabled, no entries are injected. |

### Vault Connections

DeepLore Enhanced supports multiple Obsidian vaults. Each vault has its own name, port, API key, and enable toggle. Entries from all enabled vaults are merged into a single index.

| Setting | Default | Description |
|---------|---------|-------------|
| **Vault Name** | (none) | Display name for this vault connection. Must match your Obsidian vault name exactly for deep links to work. |
| **Port** | `27123` | Port for the Obsidian Local REST API plugin. |
| **API Key** | (none) | Bearer token from Obsidian's Local REST API settings. |
| **Enabled** | On | Toggle this vault on/off without deleting the connection. |

**Add Vault** button adds a new vault connection. **Test All** button verifies all enabled vault connections.

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
| **Strip Duplicate Injections** | Off | Toggle | Skip re-injecting entries that were already injected in recent generations. Tracked per-chat. Constants are exempt. |
| **Lookback Depth** | `2` | 1-10 | Number of previous generations to check for already-injected entries (when Strip Duplicate Injections is on). Higher = more aggressive deduplication. |
| **Unlimited Entries** | On | Toggle | Remove the cap on how many entries can be injected per generation. |
| **Max Entries** | `10` | 1-100 | Maximum entries to inject (when Unlimited Entries is off). Sorted by priority. |
| **Unlimited Token Budget** | On | Toggle | Remove the token budget cap. A warning toast appears if injected lore exceeds 20% of context. |
| **Token Budget** | `2048` | 100-100000 | Maximum total tokens to inject (when Unlimited Token Budget is off). Entries added in priority order until budget is reached. |

## Injection

| Setting | Default | Description |
|---------|---------|-------------|
| **Injection Mode** | Extension Prompt | **Extension Prompt**: uses `setExtensionPrompt()` with fixed position/depth/role (classic behavior). **Prompt List**: registers named prompts (`deeplore_constants`, `deeplore_lore`) that appear in SillyTavern's Prompt Manager list. Drag them wherever you want. Requires Chat Completion API. |
| **Injection Template** | `<{{title}}>\n{{content}}\n</{{title}}>` | Format for each injected entry. Use `{{title}}` for entry name and `{{content}}` for note body. |
| **Injection Position** | In-chat | (Extension Prompt mode only) Where to inject lore. Options: Before Main Prompt/Story String, After Main Prompt/Story String, or In-chat @ Depth. |
| **Injection Depth** | `4` | 0-9999. Chat depth for in-chat injection (0 = last message). |
| **Injection Role** | System | Message role for in-chat injection: System, User, or Assistant. |
| **Allow World Info Scan** | Off | Let SillyTavern's built-in World Info system scan injected lore for WI keyword matches. Enables cross-system triggering. |

> Entries can override position, depth, and role via frontmatter. See [[Writing Vault Entries]].
>
> In **Prompt List** mode, global position/depth/role settings are ignored — the Prompt Manager controls placement. Per-entry frontmatter overrides with custom depth/position still create separate injection groups that bypass the PM.

## Context Cartographer

| Setting | Default | Description |
|---------|---------|-------------|
| **Show Lore Sources Button** | On | Add a book icon to AI messages showing which entries were injected and why. See [[Features#Context Cartographer]]. |

> Deep links use the vault connection name to build Obsidian URIs. Set vault names in Vault Connections to match your Obsidian vault names exactly.

## AI-Powered Features

AI Notebook, Session Scribe, and Auto Lorebook are grouped under one collapsible drawer in settings.

### AI Notebook

| Setting | Default | Description |
|---------|---------|-------------|
| **Enable AI Notebook** | Off | Enable a persistent per-chat scratchpad that is injected into every generation. Edit via `/dle-notebook` or the Open Notebook button. See [[Features#AI Notebook]]. |
| **Notebook Injection Position** | In-chat | Where to inject the notebook. Same options as main injection: Before Main Prompt, After Main Prompt, or In-chat @ Depth. |
| **Notebook Injection Depth** | `4` | 0-9999. Chat depth for in-chat notebook injection. |
| **Notebook Injection Role** | System | Message role for in-chat notebook injection: System, User, or Assistant. |

**Open Notebook** button opens the notebook editor for the current chat.

## Search Mode

| Setting | Default | Description |
|---------|---------|-------------|
| **Search Mode** | Keyword Only | Dropdown. **Keyword Only**: keywords-only matching (no AI). **Two-Stage**: keywords pre-filter, then AI selects. **AI Only**: entire vault sent to AI. See [[AI Search]]. |

## AI Search

Visible when Search Mode is Two-Stage or AI Only.

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Connection** | Profile | Toggle | "Connection Profile" uses a saved ST profile (recommended). "Custom Proxy" uses a separate proxy server. |
| **Connection Profile** | (none) | Dropdown | (Profile mode) Select a saved Connection Manager profile. Any provider works. |
| **Proxy URL** | `http://localhost:42069` | Text | (Proxy mode) URL of the claude-code-proxy or compatible endpoint. Must expose `/v1/messages`. |
| **Model Override** | (none) | Text | Optional model override. In profile mode, leave empty to use the profile's model. In proxy mode, specify the model name. |
| **Max Response Tokens** | `1024` | 64-4096 | Token limit for the AI response. Keep low; only a JSON array is needed. |
| **Timeout (ms)** | `10000` | 1000-30000 | How long to wait for the AI before falling back to keyword-only results. |
| **AI Scan Depth** | `4` | 1-100 | Number of recent messages to send as context to the AI. Can differ from keyword scan depth. |
| **Manifest Summary Length** | `600` | 100-1000 | Max characters for entry summaries in the manifest. Only for entries without a `summary` field. |
| **System Prompt Override** | (none) | Text | Custom system prompt for AI selection. Leave empty for default. Supports `{{maxEntries}}` placeholder. |
| **Prepend "You are Claude Code"** | On | Toggle | (Proxy mode only, under Show Advanced) Prepend `You are Claude Code.` to the AI system prompt. Disable if using a non-Claude model via proxy. |
| **Scribe-Informed Retrieval** | Off | Toggle | Feed the Session Scribe's latest summary into the AI search context for better entry selection. See [[Features#Scribe-Informed Retrieval]]. |

**Test AI Search** button tests the AI connection. **Preview AI Prompt** button shows the full prompt that would be sent.

**AI Stats** shows session usage: AI calls, cache hits, estimated input/output tokens.

### Session Scribe

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

### Auto Lorebook

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Enable Auto Lorebook** | Off | Toggle | AI analyzes chat for entities not in the lorebook and suggests new entries with human review. See [[Features#Auto Lorebook]]. |
| **Interval (messages)** | `10` | 3-50 | Trigger auto-suggest every N messages. |
| **Target Folder** | (none) | Text | Obsidian folder for new entries. Leave empty for vault root. |
| **Connection Mode** | SillyTavern | Radio | `SillyTavern` (active connection), `Profile` (saved profile), or `Proxy`. |
| **Connection Profile** | (none) | Select | Connection Manager profile. Only shown in Profile mode. |
| **Proxy URL** | `http://localhost:42069` | Text | Proxy server URL. Only shown in Proxy mode. |
| **Model** | (none) | Text | Model override for suggestions. |
| **Max Tokens** | `2048` | 256-4096 | Maximum tokens for the suggestion response. |

Use `/dle-suggest` to trigger on-demand at any time.

## Entry Decay

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Enable Entry Decay** | Off | Toggle | Track entry freshness and adjust AI manifest priorities. Stale entries get a boost; frequently injected entries get a penalty. See [[Features#Entry Decay & Freshness]]. |
| **Boost Threshold** | `5` | 2-20 | Generations without injection before an entry gets a freshness boost in the AI manifest. |
| **Penalty Threshold** | `2` | 2-10 | Consecutive injections before an entry gets a frequency penalty in the AI manifest. |

## Index & Cache

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Cache TTL (seconds)** | `300` | 0-86400 | How long to cache the vault index before re-fetching. 0 = always fetch fresh (slower). |
| **Auto-Sync Interval** | `0` | 0-3600 | Seconds between automatic vault re-checks. 0 = disabled. See [[Features#Vault Change Detection & Auto-Sync]]. |
| **Show Sync Change Toasts** | On | Toggle | Show toast notifications when vault changes are detected during index refresh. |

**Refresh Index** button clears the cache and re-fetches all entries. **Test Match** button simulates a generation to show which entries would match.

> **Show Advanced toggles:** Several sections have "Show Advanced" toggles that reveal power-user settings. These toggles persist across sessions. Settings behind advanced toggles include: seed/bootstrap tags, case sensitivity, whole word matching, recursive scanning, re-injection cooldown, deduplication, injection template, WI scan, AI manifest summary length, system prompt override, Claude Code prefix, cache TTL, sync interval, and sync toasts.

## Advanced

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Review Response Tokens** | `0` | 0-100000 | Token limit for `/dle-review` responses. 0 = auto (uses your connection profile's Max Response Length). |
| **Debug Mode** | Off | Toggle | Log detailed match info to browser console (F12). Shows keyword matches, AI results, gating, token counts, injection details. |

## Automatic Features (No Settings)

These features work automatically with no configuration:

- **Circuit Breaker:** Obsidian connection uses a circuit breaker pattern (closed/open/half-open) with exponential backoff (2s-15s). Prevents hammering a down server. Resets automatically when a call succeeds.
- **IndexedDB Persistent Cache:** Parsed vault index is saved to IndexedDB after every successful build. On page load, hydrates instantly from cache, then validates in background. No settings to configure.
- **Incremental Delta Sync:** Auto-sync fetches only the file listing first, then downloads content only for new files. Falls back to full rebuild automatically.
- **Hierarchical Manifest Clustering:** For vaults with 40+ entries and 4+ categories, automatically uses two-call AI approach for better scaling.
- **Sliding Window AI Cache:** AI search cache tracks manifest and chat hashes separately for smarter cache reuse.
- **Confidence-Gated Budget:** AI search over-requests entries (2x), sorts by confidence tier before budget cap.
- **Prompt Cache Optimization:** In proxy mode, manifest is placed first with cache_control breakpoints for Anthropic prompt caching.
