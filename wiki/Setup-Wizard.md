# Setup Wizard

The setup wizard walks you through configuring DeepLore Enhanced for the first time. It covers vault connection, tags, matching settings, AI search, and vault structure -- everything you need to go from install to working lore injection.

## When It Runs

- **Automatically** on first load (when the extension has never been configured)
- **Manually** any time with `/dle-setup`

You can re-run the wizard at any time to reconfigure. It prefills with your current settings.

## Pages

### 1. Welcome

Introduction to what the wizard will configure. No settings on this page.

### 2. Obsidian Connection

Connect to your Obsidian vault's Local REST API.

| Field | Default | Description |
|-------|---------|-------------|
| Vault Name | Primary | Display name for this vault |
| Host | 127.0.0.1 | IP or hostname where Obsidian is running |
| Port | 27123 | REST API port (set in Obsidian plugin settings) |
| API Key | -- | Bearer token from the REST API plugin |

Click **Test Connection** to verify. The test must pass before you can continue.

> If the test fails, check that Obsidian is open and the Local REST API plugin is enabled. See [[Troubleshooting#Connection Issues]].

### 3. Tags & Search Mode

Configure which Obsidian tags identify lorebook entries, and choose your search strategy.

**Tags:**

| Tag | Default | Purpose |
|-----|---------|---------|
| Lorebook Tag | `lorebook` | Entries with this tag are indexed |
| Constant Tag | `lorebook-always` | Always injected regardless of matching |
| Seed Tag | `lorebook-seed` | Content sent to AI as story context on new chats |
| Bootstrap Tag | `lorebook-bootstrap` | Force-injected when chat is short |

**Search Mode** (radio buttons):

| Mode | Description |
|------|-------------|
| **Keywords Only** | Match entries by keyword triggers only. No AI calls. |
| **Two-Stage** | Keywords first to build a candidate list, then AI picks the best matches. Recommended. |
| **AI Only** | Send the entire vault manifest to AI for selection. More thorough but more expensive. |

If you select Keywords Only, the AI Search setup page is automatically skipped.

### 4. Matching & Performance

Configure how deep the keyword scanner looks and how many entries can be injected.

**Quick Presets:**

| Preset | Scan Depth | Max Entries | Token Budget |
|--------|-----------|-------------|--------------|
| Small | 4 | 10 | 2,048 |
| Medium | 6 | 15 | 3,072 |
| Large | 8 | 20 | 4,096 |

Click a preset to fill in the values, or set them manually:

| Field | Description |
|-------|-------------|
| Scan Depth | How many recent messages to scan for keywords (0-100) |
| Max Entries | Maximum entries to inject per generation |
| Token Budget | Maximum total tokens for injected lore |
| Unlimited Entries | Ignore the max entries cap |
| Unlimited Budget | Ignore the token budget cap |
| Fuzzy Search | Enable BM25/TF-IDF scoring alongside keyword matching |

### 5. AI Search Setup

*Skipped if you chose Keywords Only on page 3.*

Choose how DLE connects to an AI model for intelligent entry selection.

**Profile Mode** -- Use a saved SillyTavern Connection Manager profile. Select from the dropdown and test.

**Proxy Mode** -- Connect to a custom proxy (e.g., claude-code-proxy). Enter the proxy URL and model name.

Click **Test AI Connection** to verify the selected connection works.

### 6. Vault Structure

Creates starter files in your Obsidian vault:

| Item | Path | Purpose |
|------|------|---------|
| Field definitions | `DeepLore/field-definitions.yaml` | Custom gating field schema (see [[Custom Fields]]) |
| Sessions folder | `Sessions/` | Where Session Scribe writes notes |

Both are optional checkboxes. Status indicators show success or error for each.

### 7. Summary

Review everything you configured:

- Vault connection details
- Search mode
- Matching settings (entries, budget)
- Files created

Action buttons at the bottom let you immediately:
- **Run Health Check** -- Audit your entries for issues
- **Open Graph** -- Visualize entry relationships
- **Browse Vault** -- Open the entry browser
- **Open Settings** -- Fine-tune advanced settings

## What Happens on Finish

When you click **Finish**:

1. All settings are saved
2. The extension is enabled
3. A full vault index build is triggered
4. The wizard completion flag is set (prevents auto-launch next time)

You're ready to go. Send a message and watch the Drawer's Why? tab to see lore being selected.

## See Also

- [[Installation]] -- Prerequisites and install steps
- [[Quick Start]] -- Getting started after setup
- [[Settings Reference]] -- All settings explained
