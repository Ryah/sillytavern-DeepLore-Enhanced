# DeepLore Enhanced - AI-Powered Obsidian Vault Lorebook for SillyTavern

> **Personal project.** 814 tests (649 unit + 165 integration), used daily against a 130+ entry vault, in beta. Bug reports welcome but fixes might take time -- I work.


### Testimonials (used with permission):

- *"[I've] been using it all day and still amazed by it."* — /u/chaeriixo (via [reddit.com](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/obxd24v/))
- *"I just installed this and this has all the features that I've been doing manually! I've installed and have been messing around with it. This is freaking amazing and also dangerous, because I love world building as well."* - /u/realedazed (via [reddit.com](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/obxwj40/))


## What is This?

When you roleplay with an AI in SillyTavern, the AI only sees what's in the current prompt: the character card, the system prompt, and the most recent messages. It has no memory of your world. If your story has a hundred characters, three factions, a magic system, and a political history, the AI doesn't know any of that unless you tell it -- every time.

A **lorebook** solves this. It's a collection of reference entries about your world -- characters, locations, factions, lore -- with trigger keywords that automatically inject the right entries into the AI's context when they're relevant. SillyTavern has a built-in lorebook system (World Info) that does keyword matching. DeepLore Enhanced goes further.

**DeepLore Enhanced** stores your lore in an [Obsidian](https://obsidian.md/) vault and uses a two-stage retrieval pipeline:

1. **Keywords cast a wide net** -- every entry's trigger words are checked against recent messages
2. **An AI narrows it down** -- a fast model reads the conversation and selects which candidates actually matter right now

A conversation about "the consequences of breaking an oath" can pull in your entry about Bloodchains without the word "Bloodchain" ever being mentioned. The AI finds what's contextually relevant, not just what's lexically matched.

Your lore lives as plain markdown files in Obsidian -- not locked inside a JSON blob. You get backlinks, graph views, templates, and the full Obsidian plugin ecosystem for organizing your world.

> **Do NOT run this alongside [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore).** They are the same extension family. DeepLore is the stable keyword-only version. Enhanced is a superset that adds AI search and advanced features. Pick one.

**Full documentation: [Wiki](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki)**

## Features

- **AI-powered entry selection** -- Two-stage pipeline (keywords -> AI) or AI-only mode with sliding window cache and hierarchical clustering for large vaults
- **Any AI provider** -- Works with Anthropic, OpenAI, OpenRouter, or any provider via SillyTavern's Connection Manager
- **Multi-vault support** -- Connect multiple Obsidian vaults with independent settings, merged into a single index
- **Per-chat pin/block** -- Pin entries to always inject or block entries from injecting, per chat
- **Contextual gating** -- Filter entries by era, location, scene type, and present characters via frontmatter + slash commands
- **Context Cartographer** -- Token bar charts, injection position grouping, vault attribution, expandable previews per message
- **Session Scribe** -- Auto-summarize sessions to your Obsidian vault with session timeline
- **Author's Notebook** -- Persistent per-chat scratchpad injected every turn
- **Auto Lorebook** -- AI suggests new entries from chat context with human review gate
- **ST lorebook import** -- Convert SillyTavern World Info JSON exports into Obsidian vault notes (`/dle-import`)
- **Quick actions bar** -- One-click toolbar in settings for Browse, Health, Graph, Simulate, and more
- **Fine-grained matching** -- Conditional gating, cooldown/warmup, probability, refine keys, cascade links, per-entry injection overrides
- **Diagnostic toolkit** -- 30+ health checks, pipeline inspector, activation simulation, "Why Not?" diagnostics, entry browser, relationship graph
- **Smart caching** -- IndexedDB persistence for instant page loads, reuse sync for unchanged entries, circuit breaker for Obsidian connection

See the [Wiki: Features](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Features) for the full list.

## Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.12.0+)
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled
- **For AI search (one of):**
  - A saved **Connection Manager profile** in SillyTavern (any provider) -- **recommended, no extra setup**
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
| What is DeepLore? | [Wiki: What is DeepLore](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/What-is-DeepLore) |
| Installation | [Wiki: Installation](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Installation) |
| Quick Start | [Wiki: Quick Start](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Quick-Start) |
| Writing Vault Entries | [Wiki: Writing Vault Entries](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Writing-Vault-Entries) |
| AI Search | [Wiki: AI Search](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/AI-Search) |
| Pipeline | [Wiki: Pipeline](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Pipeline) |
| Features | [Wiki: Features](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Features) |
| Settings Reference | [Wiki: Settings Reference](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Settings-Reference) |
| Slash Commands | [Wiki: Slash Commands](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Slash-Commands) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

## License

MIT
