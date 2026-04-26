# Security

DeepLore Enhanced is a client-side SillyTavern extension that connects to a local Obsidian vault via the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

## Data Flow

- All vault data stays on your local machine (browser to Obsidian, both localhost)
- DLE both reads and writes to the vault: Scribe notes, auto-suggest entries, imports, and Librarian review results can create or modify vault files
- AI search calls route through SillyTavern's Connection Manager or CORS proxy — no direct external calls from the extension
- AI API keys (OpenRouter, OpenAI, etc.) are managed entirely by SillyTavern — DLE does not store or handle them. DLE only stores the Obsidian REST API key in SillyTavern's `extension_settings` (browser localStorage)

## Reporting Issues

For security vulnerabilities, please use [GitHub private vulnerability reporting](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/security/advisories/new) or contact the maintainer privately before opening a public issue. This allows time to assess and patch before disclosure.

For non-security bugs, use [GitHub Issues](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues).
