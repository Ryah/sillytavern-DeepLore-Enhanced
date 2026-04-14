<p align="center">
  <img alt="DeepLore Enhanced" src="wiki/images/full-logo.png">
</p>

<p align="center">
  <strong>AI-Powered Obsidian Vault Lorebook for SillyTavern</strong><br>
  Your worldbuilding lives in Obsidian. DeepLore makes sure the AI actually reads it.
</p>

<p align="center">
  <a href="https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki">Wiki</a> &middot;
  <a href="https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Installation">Install</a> &middot;
  <a href="https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Quick-Start">Quick Start</a> &middot;
  <a href="https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Slash-Commands">Commands</a> &middot;
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <a href="https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/actions/workflows/tests.yml"><img alt="Tests" src="https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/actions/workflows/tests.yml/badge.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-2.0.0--beta-blue">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="SillyTavern" src="https://img.shields.io/badge/SillyTavern-1.12.6%2B-purple">
</p>

---

### What people are saying:

> *"[I've] been using it all day and still amazed by it."*
> — /u/chaeriixo ([reddit](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/obxd24v/))

> *"I just installed this and this has all the features that I've been doing manually! This is freaking amazing and also dangerous, because I love world building as well."*
> — /u/realedazed ([reddit](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/obxwj40/))

> *"I figured [how to import SillyTavern lore] out! This seems really cool! I have imported my lorebooks into an Obsidian vault and my brain is exploding a bit because I have a HUGE chat with naturally HUGE lorebooks and there are so many things floating around my graphs. It was very easy to set up once I got past the newness of Obsidian. The wizard was easy to follow and clear. I can easily see myself spending hours curating my vaults this weekend."*
> — /u/morty_morty ([reddit](https://www.reddit.com/r/SillyTavernAI/comments/1sayvas/announcing_deeplore_enhanced_10beta_your_obsidian/oe4edb8/)

---

## The Problem

When you roleplay with an AI, it only sees what's in the current prompt: the character card, the system prompt, and the last few messages. It has no memory of your world. A hundred characters, three factions, a magic system, a thousand years of history — the AI knows none of it unless you tell it, every single time.

A **lorebook** fixes this by injecting reference entries into the prompt when they become relevant. SillyTavern has a built-in lorebook (World Info), but it's limited to exact keyword matching against a JSON file.

**DeepLore Enhanced** takes a different approach. Your lore lives as plain markdown in an [Obsidian](https://obsidian.md/) vault — backlinks, graph view, templates, the full plugin ecosystem. DLE indexes your vault and runs a retrieval pipeline every generation:

```
 Obsidian Vault                     SillyTavern
 ┌─────────────────┐               ┌───────────────────────┐
 │  Markdown notes │    index      │                       │
 │  with YAML      │ ───────────▶ | DeepLore Enhanced     │ ──▶ Injected into
 │  frontmatter    │  (REST API)   │                       │     the AI prompt
 │                 │               │  1. Keyword scan      │
 │  #lorebook tag  │               │  2. AI selection      │ 
 │  keys, summary  │               │  3. Gating & filters  |
 │  priority, etc. │               │  4. Budget & format   │
 └─────────────────┘               └───────────────────────┘
```

**Keywords cast a wide net; AI narrows it down.** A conversation about "the consequences of breaking an oath" can pull in your Bloodchain entry without the word ever being mentioned. The AI finds what's *contextually* relevant, not just what's lexically matched.

See [Wiki: Pipeline](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Pipeline) for the full technical breakdown.

> **Do NOT run both [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) and DeepLore Enhanced.** They are the same extension family. DeepLore is the stable keyword-only version, but is now deprecated. DeepLore Enhanced is a superset that adds AI search and advanced features. Use this one.

---

<p align="center">
  <img src="https://raw.githubusercontent.com/pixelnull/sillytavern-DeepLore-Enhanced/main/wiki/images/dle-drawer.png" alt="DLE Drawer panel showing the Browse tab with a filterable entry list, token budget bar, priority badges, and temperature heatmap coloring across 234 vault entries" width="360">
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/pixelnull/sillytavern-DeepLore-Enhanced/main/wiki/images/dle-graph.png" alt="Entry Relationship Graph visualization showing 209 nodes and 418 edges in a force-directed layout with color-coded node types for Constants, Seeds, Bootstrap, and Regular entries" width="360">
</p>

## Who is this for?

- **You have an Obsidian vault full of characters, factions, and history** — and you want the AI to actually use it.
- **You're tired of World Info keyword matching missing the point** of the conversation.
- **You want one source of truth** for your world that works in Obsidian AND in SillyTavern.

## Features

### Smart Selection
- **Two-stage matching** — keywords find candidates, AI picks what's actually relevant
- **BM25 fuzzy search** catches near-misses that exact keywords would drop
- **Hierarchical pre-filtering** — AI picks relevant categories first, then individual entries
- **Works with any AI provider** — Anthropic, OpenAI, OpenRouter, or anything SillyTavern supports

### Your Lore, Your Rules
- **Contextual gating** — era, location, scene type, character presence filters
- **Custom field definitions** with visual rule builder (mood, faction, time_of_day — anything)
- **Per-chat pins and blocks**, cooldowns, warmup thresholds, probability gates
- **Multiple vaults** — merge entries from separate Obsidian vaults with clear attribution

### AI-Powered Tools
- **Session Scribe** — auto-summarize chats back to your vault with timeline view
- **AI Review** — get feedback on your entire vault's entries
- **Auto Lorebook** — AI suggests new entries from chat context
- **AI Notepad** — the AI maintains running session notes, reinjected as context

### See Everything
- **Live drawer panel** — Why?/Browse/Gating/Tools tabs without leaving the chat
- **Relationship graph** — force-directed layout with clustering, focus mode, and gap analysis
- **Context Cartographer** — see exactly which entries injected and why, per message
- **30+ health checks**, pipeline inspector, activation simulation, "Why Not?" diagnostics

See [Wiki: Features](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Features) for the full list.

---

## What an Entry Looks Like

A lorebook entry is just an Obsidian note with YAML frontmatter:

```markdown
---
tags:
  - lorebook
keys:
  - Bloodchain
  - blood bond
  - feeding addiction
priority: 35
summary: The biological dependency created when a vampire feeds from a mortal.
  Select when feeding, biting, addiction, venom, or chattel dynamics come up.
---

# Bloodchains

A Bloodchain forms when a vampire feeds from the same mortal three or more times.
The vampire's saliva carries a bonding compound that creates physical dependency
in the mortal — withdrawal symptoms, heightened suggestibility, and an
overwhelming compulsion to seek out their bonded vampire.

The bond is not symmetrical. The mortal is addicted; the vampire feels nothing.
```

When someone mentions feeding, blood bonds, or addiction in chat, DLE injects this entry behind the scenes. The AI writes as if it always knew how Bloodchains work — even if the word "Bloodchain" was never said.

See [Wiki: Writing Vault Entries](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Writing-Vault-Entries) for the full frontmatter reference, priority guidelines, and copy-paste templates.

---

## Get Started in 5 Minutes

**You need:**
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) 1.12.6+
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin enabled
- For AI search (optional): a saved Connection Manager profile in SillyTavern, or [claude-code-proxy](https://github.com/horselock/claude-code-proxy) with CORS proxy enabled

**Install:**
1. Paste `https://github.com/pixelnull/sillytavern-DeepLore-Enhanced` into SillyTavern's extension installer
2. Restart SillyTavern
3. Run `/dle-setup` to configure your Obsidian connection and AI search

**After setup:**
1. Tag your Obsidian notes with `lorebook` in frontmatter and add `keys`
2. Run `/dle-health` to check your entries for common issues
3. Start chatting — your lore injects automatically

See [Wiki: Installation](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Installation) and [Wiki: Quick Start](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Quick-Start) for the detailed walkthrough with screenshots.

---

## Search Modes

| Mode | How it works | Cost | Best for |
|------|-------------|------|----------|
| **Keyword Only** | Exact keyword + BM25 fuzzy matching against recent chat | Free | Simple setups, no API needed |
| **Two-Stage** (default) | Keywords pre-filter, then AI selects best matches | ~1 cheap API call/message | Most users — balances cost and quality |
| **AI Only** | Full vault manifest sent to AI, no keyword filter | More tokens per call | Maximum recall, small-medium vaults |

All modes fall back gracefully: if AI search fails, keyword results are used. If AI returns nothing, only constants are injected.

See [Wiki: AI Search](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/AI-Search) for configuration and connection setup.

---

## Slash Commands

Type `/dle-help` in the SillyTavern chat input for the full in-app reference, or see the [complete command reference](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Slash-Commands) on the wiki.

---

## Documentation

| Page | Description |
|------|-------------|
| [What is DeepLore?](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/What-is-DeepLore) | The problem, the approach, and who DLE is for |
| [Installation](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Installation) | Step-by-step setup guide |
| [Quick Start](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Quick-Start) | Get injecting lore in 5 minutes |
| [First Steps](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/First-Steps) | Building your vault and tuning the extension |
| [Writing Vault Entries](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Writing-Vault-Entries) | Frontmatter reference and copy-paste templates |
| [Features](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Features) | Full feature catalog with links to detail pages |
| [AI Search](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/AI-Search) | Semantic search modes, connection setup, and tuning |
| [Pipeline](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Pipeline) | How the matching pipeline works under the hood |
| [Drawer](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Drawer) | Live side panel guide |
| [Inspection & Diagnostics](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Inspection-and-Diagnostics) | Pipeline inspector, health checks, simulation |
| [Entry Matching & Behavior](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Entry-Matching-and-Behavior) | Cooldowns, gating, decay, conditional rules |
| [AI-Powered Tools](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/AI-Powered-Tools) | Scribe, Auto Lorebook, Optimize Keys, AI Notepad |
| [Setup & Import](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Setup-and-Import) | Setup wizard and World Info import |
| [Injection & Context Control](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Injection-and-Context-Control) | Positions, roles, templates, deduplication |
| [Infrastructure](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Infrastructure) | Caching, multi-vault, sync, circuit breaker |
| [Settings Reference](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Settings-Reference) | Every setting documented |
| [Slash Commands](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Slash-Commands) | All commands with usage examples |
| [Troubleshooting](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Troubleshooting) | Common issues and fixes |
| [FAQ](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/FAQ) | Frequently asked questions |
| [Glossary](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Glossary) | Terminology reference |

---

## FAQ

**Do I need AI search?** No. Keyword-only mode works with no API costs. AI search is an optional second stage that improves relevance for complex worlds.

**What AI providers work?** Any provider SillyTavern supports — Anthropic, OpenAI, OpenRouter, Google, local models. A cheap, fast model like Claude Haiku or GPT-4o-mini is ideal.

**Does this cost money?** Only if you use AI search. Each message costs a fraction of a cent with a cheap model. The sliding window cache further reduces calls.

**How big can my vault be?** Tested daily with 200+ entries. Hierarchical clustering kicks in at 40+ entries to keep AI calls efficient.

**Can I import my SillyTavern lorebooks?** Yes. `/dle-import` converts World Info JSON exports into Obsidian vault notes with proper frontmatter.

See the [full FAQ](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/FAQ) on the wiki.

---

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced).

**Running tests:**

```bash
npm test                 # Unit tests
npm run test:integration # Integration tests
npm run test:all         # Both
npm run test:imports     # Verify import paths
```

## License

[MIT](LICENSE)
