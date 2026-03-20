# DeepLore Enhanced - AI-Powered Obsidian Vault Lorebook for SillyTavern

> **Personal project -- not for general use.** This fork exists for my own setup and workflow. I develop and test it against my specific stack. If something breaks for you but works for me, I won't be able to help -- I can't fix bugs I can't replicate. No support is offered.

> **Do NOT run this alongside DeepLore.** Running both DeepLore and DeepLore Enhanced at the same time is not supported and will cause conflicts. Disable or uninstall DeepLore before using this extension. If you run into issues with both installed, the fix is to pick one and remove the other.

DeepLore Enhanced is a fork of [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) that adds **AI-powered semantic search** on top of the existing keyword matching system. It uses any AI provider configured in SillyTavern's Connection Manager (or a custom proxy like [claude-code-proxy](https://github.com/horselock/claude-code-proxy)) to find vault entries that are *contextually relevant* to the conversation, even when no exact keywords match.

**Full documentation: [Wiki](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki)**

## Features

- **AI-powered entry selection** -- Two-stage pipeline (keywords → AI) or AI-only mode with sliding window cache and hierarchical clustering for large vaults
- **Any AI provider** -- Works with Anthropic, OpenAI, OpenRouter, or any provider via SillyTavern's Connection Manager
- **Multi-vault support** -- Connect multiple Obsidian vaults with independent settings, merged into a single index
- **Per-chat pin/block** -- Pin entries to always inject or block entries from injecting, per chat
- **Contextual gating** -- Filter entries by era, location, scene type, and present characters via frontmatter + slash commands
- **Context Cartographer** -- Token bar charts, injection position grouping, vault attribution, expandable previews per message
- **Session Scribe** -- Auto-summarize sessions to your Obsidian vault with session timeline
- **AI Notebook** -- Persistent per-chat scratchpad injected every turn
- **Auto Lorebook** -- AI suggests new entries from chat context with human review gate
- **ST lorebook import** -- Convert SillyTavern World Info JSON exports into Obsidian vault notes (`/dle-import`)
- **Quick actions bar** -- One-click toolbar in settings for Browse, Health, Graph, Simulate, and more
- **Fine-grained matching** -- Conditional gating, cooldown/warmup, probability, refine keys, cascade links, per-entry injection overrides
- **Diagnostic toolkit** -- 30+ health checks, pipeline inspector, activation simulation, "Why Not?" diagnostics, entry browser, relationship graph
- **Smart caching** -- IndexedDB persistence for instant page loads, incremental delta sync, circuit breaker for Obsidian connection

See the [Wiki: Features](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Features) for the full list.

## Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.12.0+)
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled
- **For AI search (one of):**
  - A saved **Connection Manager profile** in SillyTavern (any provider) — **recommended, no extra setup**
  - OR [claude-code-proxy](https://github.com/horselock/claude-code-proxy) running locally (requires `enableCorsProxy: true` in `config.yaml`)

## Installation

See the [Installation Guide](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Installation) for full instructions.

**Quick start:**

1. Install via SillyTavern's extension installer: paste `https://github.com/pixelnull/sillytavern-DeepLore-Enhanced`
2. Restart SillyTavern
3. Configure your Obsidian connection in the extension settings

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
