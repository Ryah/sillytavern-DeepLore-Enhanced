# Installation

Step-by-step guide to installing and configuring DeepLore Enhanced.

## Prerequisites

Before you begin, make sure you have:

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) **1.12.0+**
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled
- **For AI search** (one of):
  - A saved Connection Manager profile in SillyTavern (any provider: Anthropic, OpenAI, OpenRouter, etc.)
  - [claude-code-proxy](https://github.com/horselock/claude-code-proxy) running locally (requires `enableCorsProxy: true` in `config.yaml`)

> **Do NOT run both DeepLore and DeepLore Enhanced.** They will conflict. Pick one.

---

## Step 1: Install the Client Extension

### Option A: Built-in Installer (Recommended)

1. Open SillyTavern
2. Go to the **Extensions** panel (puzzle piece icon)
3. Click **Install Extension**
4. Paste the URL:
   ```
   https://github.com/pixelnull/sillytavern-DeepLore-Enhanced
   ```
5. Click **Install**

### Option B: Manual Git Clone

```bash
cd SillyTavern/data/default-user/extensions
git clone https://github.com/pixelnull/sillytavern-DeepLore-Enhanced.git
```

---

## Step 2: Restart SillyTavern

Stop and restart SillyTavern to load the new extension.

---

## First-Time Setup

> **Quick alternative:** Run `/dle-setup` in the SillyTavern chat input to use the guided setup wizard. It walks through Obsidian connection, AI search, and initial index build step by step.

### Obsidian Connection

1. In Obsidian, open **Settings > Community Plugins** and install/enable **Local REST API**
2. Go to **Settings > Local REST API** and note the **API port** (default: `27123`) and copy the **API key**
3. In SillyTavern, go to **Extensions > DeepLore Enhanced**
4. Enter the port and API key in the connection fields
5. Click **Test Connection**. You should see a success message
6. Check **Enable DeepLore Enhanced**
7. Click **Refresh Index** to pull entries from your vault

At this point, any entries in your vault tagged with `#lorebook` will be matched by keywords during generation. See [[Writing Vault Entries]] for how to create and tag entries.

### AI Search Setup (Optional)

AI search adds a second stage to the pipeline: after keyword pre-filtering, an AI model reviews the candidate entries and selects the most contextually relevant ones. See [[AI Search]] for a full explanation of how it works.

#### Option A: Connection Profile (Recommended)

This uses an existing SillyTavern API connection with no extra software.

1. Make sure you have at least one API connection set up in SillyTavern and saved as a **Connection Manager profile**
2. In DLE settings, scroll down to **AI Search**
3. Check **Enable AI Search**
4. Set connection mode to **Connection Profile** (this is the default)
5. Choose your profile from the dropdown
6. Optionally set a **Model Override** (e.g., to force a cheaper model like Haiku)
7. Click **Test AI Search** to verify

#### Option B: Custom Proxy

This routes AI requests through an external proxy server via SillyTavern's built-in CORS proxy.

1. Install and start [claude-code-proxy](https://github.com/horselock/claude-code-proxy) (defaults to `http://localhost:42069`)
2. **Enable the CORS proxy:** Open `SillyTavern/config.yaml` and set `enableCorsProxy: true`, then restart SillyTavern. (Alternatively, install the optional server plugin from the `server/` folder — it auto-enables this setting.)
3. In DLE settings, scroll down to **AI Search**
4. Check **Enable AI Search**
5. Set connection mode to **Custom Proxy**
6. Set the **Proxy URL** (e.g., `http://localhost:42069`)
7. Set the **Model Override** (e.g., `claude-haiku-4-5-20251001`)
8. Click **Test AI Search** to verify

---

## Updating

If you installed via the built-in installer, SillyTavern will show an update notification when a new version is available. Click **Update** in the Extensions panel.

If you installed manually, pull the latest changes:

```bash
cd SillyTavern/data/default-user/extensions/sillytavern-DeepLore-Enhanced
git pull
```

---

## Troubleshooting

### Connection refused (Obsidian)

- **Is Obsidian open?** The Local REST API plugin only serves requests while Obsidian is running.
- **Is the Local REST API plugin enabled?** Check Obsidian Settings > Community Plugins.
- **Check the port:** The default is `27123`. Make sure the port in DLE settings matches what Local REST API is using.
- **Check the API key:** Copy it fresh from Obsidian Settings > Local REST API. Keys are regenerated when the plugin is reinstalled.
- **Firewall:** If SillyTavern and Obsidian are on different machines, ensure the port is open.

### AI Search test fails

- **Connection Profile mode:** Make sure the selected profile still exists and its underlying API connection works. Test the connection in SillyTavern's main API panel first.
- **Custom Proxy mode:** Verify the proxy is running (`curl http://localhost:42069` or equivalent). Ensure `enableCorsProxy: true` is set in `config.yaml`. Check the proxy's console for errors.
- **Timeout:** AI search has a configurable timeout (default 10 seconds). Slow providers may need a longer timeout in [[Settings Reference]].

### No entries found after Refresh Index

- **Check your tags:** Entries must have the `#lorebook` tag (or whatever you set as the lorebook tag in settings). The tag must be in the frontmatter `tags` array.
- **Check the vault directory:** By default, DLE scans the entire vault. If you have entries in a specific folder, make sure there are no path issues.
- **Check frontmatter format:** Keys and other fields must be valid YAML. See [[Writing Vault Entries]] for the correct format.

### Extension not appearing in SillyTavern

- **Check the extensions folder:** The extension should be at `SillyTavern/data/default-user/extensions/sillytavern-DeepLore-Enhanced/` with `manifest.json` at the root.
- **Check SillyTavern version:** DeepLore Enhanced requires SillyTavern 1.12.0 or later.
- **Clear browser cache:** Hard-refresh (`Ctrl+Shift+R`) or clear cache and reload.
