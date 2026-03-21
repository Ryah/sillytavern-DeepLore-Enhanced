# DeepLore Enhanced

**AI-Powered Obsidian Vault Lorebook for SillyTavern**

DeepLore Enhanced connects your [Obsidian](https://obsidian.md/) vault to [SillyTavern](https://github.com/SillyTavern/SillyTavern), automatically injecting relevant lore entries into your AI prompts. It combines keyword matching with AI-powered semantic search to find entries that are contextually relevant to your conversation, even when no exact keywords match.

> **Looking for the base version?** [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) is the stable, keyword-only version recommended for most users. DeepLore Enhanced is a superset that adds AI search and advanced features.

> **Do NOT run both.** Running DeepLore and DeepLore Enhanced simultaneously will cause conflicts. Pick one.

## Key Features

- **Two-stage pipeline:** Keywords pre-filter, then AI selects the best matches (with sliding window cache and hierarchical clustering)
- **Any AI provider:** Works with Anthropic, OpenAI, OpenRouter, or any provider via SillyTavern's Connection Manager
- **Multi-vault support:** Connect multiple Obsidian vaults simultaneously
- **Per-chat pin/block:** Pin entries to always inject or block entries from injecting, per chat
- **Contextual gating:** Filter entries by era, location, scene type, and present characters
- **Context Cartographer:** See exactly which lore was injected and why on each message
- **Session Scribe:** Auto-summarize sessions back to your Obsidian vault
- **Auto Lorebook:** AI analyzes chat and suggests new entries you can accept or reject
- **Author's Notebook:** Persistent per-chat scratchpad injected into every generation
- **ST lorebook import:** Convert SillyTavern World Info JSON exports into Obsidian vault notes
- **Quick actions bar:** One-click toolbar for common operations in settings
- **Fine-grained matching:** Conditional gating, cooldown/warmup, probability, refine keys, cascade links, per-entry injection overrides, entry decay & freshness
- **New chat bootstrapping:** Seed entries and bootstrap injection for early conversations
- **Smart infrastructure:** IndexedDB persistent cache, reuse sync (skip re-parse of unchanged entries), circuit breaker, prompt cache optimization
- **Diagnostic tools:** Analytics, health checks, pipeline inspector, activation simulation, "Why Not?" diagnostics, entry browser, relationship graph

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
