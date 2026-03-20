# DeepLore Enhanced

**AI-Powered Obsidian Vault Lorebook for SillyTavern**

DeepLore Enhanced connects your [Obsidian](https://obsidian.md/) vault to [SillyTavern](https://github.com/SillyTavern/SillyTavern), automatically injecting relevant lore entries into your AI prompts. It combines keyword matching with AI-powered semantic search to find entries that are contextually relevant to your conversation, even when no exact keywords match.

> **Looking for the base version?** [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) is the stable, keyword-only version recommended for most users. DeepLore Enhanced is a superset that adds AI search and advanced features.

> **Do NOT run both.** Running DeepLore and DeepLore Enhanced simultaneously will cause conflicts. Pick one.

## Key Features

- **Two-stage pipeline:** Keywords pre-filter, then AI selects the best matches
- **Any AI provider:** Works with Anthropic, OpenAI, OpenRouter, or any provider via SillyTavern's Connection Manager
- **Multi-vault support:** Connect multiple Obsidian vaults simultaneously
- **Context Cartographer:** See exactly which lore was injected and why on each message
- **Session Scribe:** Auto-summarize sessions back to your Obsidian vault
- **Auto Lorebook:** AI analyzes chat and suggests new entries you can accept or reject
- **AI Notebook:** Persistent per-chat scratchpad injected into every generation
- **Conditional gating:** Entries that depend on or block other entries
- **Per-entry injection:** Override injection position, depth, and role per entry
- **Cooldown/warmup tags:** Fine-grained control over when entries trigger
- **Injection deduplication:** Prevent the same lore from being injected in consecutive generations
- **New chat bootstrapping:** Seed entries and bootstrap injection for early conversations
- **Vault sync:** Auto-detect changes in your vault
- **Diagnostic tools:** Analytics, health checks, pipeline inspector, entry browser, relationship graph, simulation

## Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) 1.12.0+
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin
- For AI search: a saved Connection Manager profile in SillyTavern (any provider), or [claude-code-proxy](https://github.com/horselock/claude-code-proxy) with `enableCorsProxy: true`

## Wiki Pages

| Page | Description |
|------|-------------|
| [[Installation]] | Step-by-step setup guide |
| [[Writing Vault Entries]] | How to create lorebook entries with copy-paste templates |
| [[AI Search]] | How AI-powered semantic search works |
| [[Pipeline]] | How the matching pipeline processes entries |
| [[Features]] | All features explained in detail |
| [[Settings Reference]] | Every setting documented |
| [[Slash Commands]] | All available slash commands |
