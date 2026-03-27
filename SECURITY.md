# Security

DeepLore Enhanced is a client-side SillyTavern extension that connects to a local Obsidian vault via the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

## Data Flow

- All vault data stays on your local machine (browser to Obsidian, both localhost)
- AI search calls route through SillyTavern's Connection Manager or CORS proxy — no direct external calls from the extension
- API keys are stored in SillyTavern's `extension_settings` (browser localStorage)

## Reporting Issues

Report security concerns via [GitHub Issues](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues).
