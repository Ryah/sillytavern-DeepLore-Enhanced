# DeepLore Enhanced - AI-Powered Obsidian Vault Lorebook for SillyTavern

> **Upgrading?** Make sure to reinstall the server plugin after updating. Run `install-server.bat` (Windows) or `./install-server.sh` (Linux/Mac), then restart SillyTavern.

> **Personal project -- not for general use.** This fork exists for my own setup and workflow. I develop and test it against my specific stack. If something breaks for you but works for me, I won't be able to help -- I can't fix bugs I can't replicate. No support is offered.

> **Do NOT run this alongside DeepLore.** Running both DeepLore and DeepLore Enhanced at the same time is not supported and will cause conflicts. Disable or uninstall DeepLore before using this extension. If you run into issues with both installed, the fix is to pick one and remove the other.

DeepLore Enhanced is a fork of [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) that adds **AI-powered semantic search** on top of the existing keyword matching system. It uses any AI provider configured in SillyTavern's Connection Manager (or a custom proxy like [claude-code-proxy](https://github.com/horselock/claude-code-proxy)) to find vault entries that are *contextually relevant* to the conversation, even when no exact keywords match.

**Full documentation: [Wiki](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki)**

## Features

- **AI-powered entry selection** -- Two-stage pipeline (keywords → AI) or AI-only mode with smart caching
- **Any AI provider** -- Works with Anthropic, OpenAI, OpenRouter, or any provider via SillyTavern's Connection Manager
- **Multi-vault support** -- Connect multiple Obsidian vaults with independent settings, merged into a single index
- **AI Notebook** -- Persistent per-chat scratchpad injected every turn (`/dle-notebook`)
- **Entry Browser** -- Searchable, filterable popup of all indexed entries with content preview (`/dle-browse`)
- **Entry Relationship Graph** -- Interactive force-directed visualization of entry connections (`/dle-graph`)
- **Context Cartographer** -- Token bar charts, injection position grouping, vault attribution, expandable previews
- **Session Scribe** -- Auto-summarize sessions to your Obsidian vault with session timeline (`/dle-scribe-history`)
- **Auto Lorebook Creation** -- AI suggests new entries from chat context with human review (`/dle-suggest`)
- **Optimize Keywords** -- AI-powered keyword suggestions, mode-aware (`/dle-optimize-keys`)
- **Activation Simulation** -- Replay chat history showing entry activation/deactivation (`/dle-simulate`)
- **"Why Not?" Diagnostics** -- Click unmatched entries to see exactly why they didn't fire
- **Self-healing health checks** -- 30+ automated checks with `/dle-health` and auto-run on load
- **Probability frontmatter** -- Per-entry random trigger chance (0.0-1.0)
- **Injection deduplication** -- Skip re-injecting entries already in recent context
- **Conditional gating** -- Entries that depend on or block other entries
- **Per-entry injection** -- Override injection position, depth, and role per entry
- **Vault change detection** -- Detects added, removed, and modified entries with optional toast notifications
- **Cooldown & warmup** -- Per-entry cooldown and warmup thresholds
- **Pipeline inspector** -- View detailed traces of keyword matches, AI selections, and fallback status

## Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.12.0+)
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled
- Server plugins enabled in SillyTavern (`enableServerPlugins: true` in `config.yaml`)
- **For AI search (one of):**
  - A saved **Connection Manager profile** in SillyTavern (any provider) — **recommended, no extra setup**
  - OR [claude-code-proxy](https://github.com/horselock/claude-code-proxy) running locally (legacy/advanced)

## Installation

See the [Installation Guide](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Installation) for full instructions.

**Quick start:**

1. Install via SillyTavern's extension installer: paste `https://github.com/pixelnull/sillytavern-DeepLore-Enhanced`
2. Install the server plugin: run `install-server.bat` (Windows) or `./install-server.sh` (Linux/Mac)
3. Set `enableServerPlugins: true` in `config.yaml`
4. Restart SillyTavern

## Documentation

| Topic | Link |
|-------|------|
| Installation | [Wiki: Installation](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Installation) |
| Writing Vault Entries | [Wiki: Writing Vault Entries](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Writing-Vault-Entries) |
| AI Search | [Wiki: AI Search](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/AI-Search) |
| Pipeline | [Wiki: Pipeline](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Pipeline) |
| Features | [Wiki: Features](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Features) |
| Settings Reference | [Wiki: Settings Reference](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Settings-Reference) |
| Slash Commands | [Wiki: Slash Commands](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Slash-Commands) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

## License

MIT
