# DeepLore Enhanced - AI-Powered Obsidian Vault Lorebook for SillyTavern

> **Looking for a supported version?** You probably want **[DeepLore](https://github.com/pixelnull/sillytavern-DeepLore)** instead. DeepLore is the stable, general-purpose version with keyword-based lorebook matching. It's what I'd recommend for most people.

> **Personal project -- not for general use.** This fork exists for my own setup and workflow. I develop and test it against my specific stack. If something breaks for you but works for me, I won't be able to help -- I can't fix bugs I can't replicate. No support is offered. If you don't need AI-powered search, use [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore).

> **Do NOT run this alongside DeepLore.** Running both DeepLore and DeepLore Enhanced at the same time is not supported and will cause conflicts. Disable or uninstall DeepLore before using this extension. If you run into issues with both installed, the fix is to pick one and remove the other.

DeepLore Enhanced is a fork of [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) that adds **AI-powered semantic search** on top of the existing keyword matching system. It uses any AI provider configured in SillyTavern's Connection Manager (or a custom proxy like [claude-code-proxy](https://github.com/horselock/claude-code-proxy)) to find vault entries that are *contextually relevant* to the conversation, even when no exact keywords match.

**Full documentation: [Wiki](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki)**

## Features

- **AI-powered entry selection** -- Two-stage pipeline (keywords → AI) or AI-only mode with smart caching
- **Any AI provider** -- Works with Anthropic, OpenAI, OpenRouter, or any provider via SillyTavern's Connection Manager
- **Context Cartographer** -- See exactly which lore was injected and why on each message
- **Session Scribe** -- Auto-summarize sessions to your Obsidian vault with configurable AI connection
- **Conditional gating** -- Entries that depend on or block other entries
- **Per-entry injection** -- Override injection position, depth, and role per entry
- **Vault change detection** -- Detects added, removed, and modified entries with optional toast notifications
- **New chat features** -- Seed entries for AI context, bootstrap entries for force-injection on new chats
- **Cooldown & warmup** -- Per-entry cooldown and warmup thresholds
- **Pipeline inspector** -- View detailed traces of keyword matches, AI selections, and fallback status
- **Entry analytics & health** -- Track usage and audit entries for common issues

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
