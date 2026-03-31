<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/icon-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/icon-light.svg">
    <img alt="DeepLore Enhanced" src="docs/icon-light.svg" width="96">
  </picture>
</p>

# DeepLore Enhanced - AI-Powered Obsidian Vault Lorebook for SillyTavern

Your AI finally understands your world's lore. DeepLore Enhanced connects your Obsidian vault to SillyTavern and uses AI to inject exactly the right lore at the right time — no keyword guessing required.

> Stable beta with 814 tests, used daily against a 200+ entry vault. Bug reports welcome at [Issues](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues).

[![Tests](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/actions/workflows/tests.yml/badge.svg)](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/actions/workflows/tests.yml) ![Version](https://img.shields.io/badge/version-1.0.0--beta-blue) ![License](https://img.shields.io/badge/license-MIT-green)

### What people are saying:

> *"[I've] been using it all day and still amazed by it."*
> — /u/chaeriixo ([reddit](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/obxd24v/))

> *"I just installed this and this has all the features that I've been doing manually! This is freaking amazing and also dangerous, because I love world building as well."*
> — /u/realedazed ([reddit](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/obxwj40/))

## What is This?

When you roleplay with an AI in SillyTavern, the AI only sees what's in the current prompt. It has no memory of your world. If your story has a hundred characters, three factions, a magic system, and a political history, the AI doesn't know any of that unless you tell it — every time.

**DeepLore Enhanced** stores your lore in an [Obsidian](https://obsidian.md/) vault and uses a two-stage retrieval pipeline:

1. **Keywords cast a wide net** — every entry's trigger words are checked against recent messages
2. **An AI narrows it down** — a fast model reads the conversation and selects which candidates actually matter right now

A conversation about "the consequences of breaking an oath" can pull in your entry about Bloodchains without the word "Bloodchain" ever being mentioned. The AI finds what's contextually relevant, not just what's lexically matched.

Your lore lives as plain markdown files in Obsidian — not locked inside a JSON blob. You get backlinks, graph views, templates, and the full Obsidian plugin ecosystem for organizing your world.

> **Do NOT run this alongside [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore).** They are the same extension family. DeepLore is the stable keyword-only version. Enhanced is a superset that adds AI search and advanced features. Pick one.

## Features

- **The AI picks your lore for you** — Two-stage pipeline (keywords then AI) or AI-only mode, so the right entries show up even when keywords aren't mentioned
- **Works with any AI provider** — Anthropic, OpenAI, OpenRouter, or anything SillyTavern's Connection Manager supports
- **Your lore stays in Obsidian** — Plain markdown files with backlinks, templates, and the full Obsidian ecosystem
- **Connect multiple vaults** — Merge entries from separate Obsidian vaults with clear attribution
- **Control what injects per chat** — Pin entries to force-inject, block entries to suppress, filter by era/location/scene/characters
- **Custom gating fields** — Define your own frontmatter fields (mood, faction, time_of_day — anything) with a visual rule builder and filter entries dynamically
- **AI Notepad** — The AI maintains running session notes about story details, decisions, and reveals — stripped from chat, reinjected as context
- **See exactly what the AI received** — Context Cartographer shows token usage, injection positions, and content previews per message
- **Auto-write session notes** — Session Scribe summarizes your roleplay to Obsidian with a timeline view
- **AI suggests new entries** — Auto Lorebook analyzes your chat for characters and concepts you haven't documented yet
- **Import existing lorebooks** — Convert SillyTavern World Info exports into vault notes with AI-generated summaries
- **Interactive relationship graph** — Visualize how your entries connect with force-directed graph, clustering, focus mode, and gap analysis
- **Live drawer panel** — Real-time view of injected entries, vault browser, and gating controls without leaving the chat
- **Diagnose everything** — 30+ health checks, pipeline inspector, activation simulation, "Why Not?" diagnostics, entry browser
- **Zero loading delays** — Instant page loads from browser cache, with background sync to keep entries fresh
- **Fine-grained matching** — Cooldowns, warmup thresholds, probability rolls, refine keys, cascade links, and per-entry injection overrides

See the [Wiki: Features](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Features) for the full list.

## Get Started in 5 Minutes

**You need:**
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.12.0+)
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin enabled
- A saved **Connection Manager profile** in SillyTavern (any AI provider) for AI search

**Install:**
1. Paste `https://github.com/pixelnull/sillytavern-DeepLore-Enhanced` into SillyTavern's extension installer
2. Restart SillyTavern
3. Run `/dle-setup` to configure your Obsidian connection and AI search

**After setup:**
1. Tag your Obsidian notes with `lorebook` in frontmatter (`tags: [lorebook]`) and add `keys` — see [Writing Vault Entries](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Writing-Vault-Entries)
2. Run `/dle-health` to check your entries for common issues
3. Start chatting — your lore will inject automatically

See the [Installation Guide](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Installation) and [Quick Start](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Quick-Start) for detailed walkthrough.

## Documentation

| Topic | Link |
|-------|------|
| What is DeepLore? | [Wiki: What is DeepLore](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/What-is-DeepLore) |
| Installation | [Wiki: Installation](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Installation) |
| Quick Start | [Wiki: Quick Start](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Quick-Start) |
| Writing Vault Entries | [Wiki: Writing Vault Entries](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Writing-Vault-Entries) |
| AI Search | [Wiki: AI Search](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/AI-Search) |
| Pipeline | [Wiki: Pipeline](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Pipeline) |
| Features | [Wiki: Features](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Features) |
| Settings Reference | [Wiki: Settings Reference](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Settings-Reference) |
| Slash Commands | [Wiki: Slash Commands](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Slash-Commands) |
| FAQ | [Wiki: FAQ](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/FAQ) |
| Troubleshooting | [Wiki: Troubleshooting](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Troubleshooting) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

## License

MIT
