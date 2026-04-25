<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/full-logo-darkmode.png">
    <source media="(prefers-color-scheme: light)" srcset="images/full-logo-lightmode.png">
    <img alt="DeepLore" src="images/full-logo-lightmode.png">
  </picture>
</p>

**World Info keyword matching breaks at scale. DeepLore reads your Obsidian vault instead: keywords plus AI retrieval, so the right lore fires even when the word wasn't typed.**

DeepLore connects your [Obsidian](https://obsidian.md/) vault to [SillyTavern](https://github.com/SillyTavern/SillyTavern) and injects relevant lore entries into your prompts. Two-stage retrieval runs keyword matching first, then asks an AI to pick the most contextually relevant entries from what survived. The matching entry fires even when the keyword was never typed.

In v2, the writing AI flags gaps mid-generation. Emma, the Librarian agent, helps you author the entries. Your story fills in your world. Your world fires back into your story.

![DeepLore drawer panel showing the Browse tab with a filterable entry list, token budget bar, priority badges, and temperature heatmap coloring](images/dle-drawer.png)

> [!NOTE]
> The older standalone [`sillytavern-DeepLore`](https://github.com/pixelnull/sillytavern-DeepLore) extension is deprecated. This repo (formerly DeepLore Enhanced) is the active project. Do not run both at once. Running both corrupts prompt injection.

## Key features

- **Three pipeline modes:** two-stage (keywords pre-filter, then AI selects), AI-only (full vault sent to AI, no keyword filtering), and keywords-only (no AI). Two-stage is the default.
- **Any LLM provider:** Anthropic, OpenAI, OpenRouter, Gemini, DeepSeek, local backends (Ooba, KoboldCpp, llama.cpp), and anything else SillyTavern's Connection Manager supports.
- **Multi-vault support:** connect multiple Obsidian vaults at once with content-hash dedup.
- **The Librarian (Emma):** writing-AI tools (`search`, `flag`) that detect missing lore mid-generation, plus Emma, a chat agent who helps you author the entry. See `lorebook-guide` for Librarian-only writing guides.
- **Per-chat pin and block:** override entry selection per chat. Force-include or exclude specific entries.
- **Contextual gating:** filter entries by era, location, scene type, characters present, and any custom field you define in `field-definitions.yaml`. Visual rule builder included.
- **Context Cartographer:** per-message trace showing which entries fired and why (keyword hit, AI selection, constant, cascade, pin).
- **Session Scribe:** auto-summarize sessions back to your Obsidian vault as timestamped notes.
- **Auto Lorebook:** AI suggests new entries from chat content; accept or reject each one.
- **Author's Notebook and AI Notepad:** per-chat scratchpads (one human-written, one AI-written) injected as context.
- **World Info import:** `/dle-import` converts SillyTavern World Info JSON exports into vault entries.
- **Relationship graph:** force-directed layout, 200+ nodes, Louvain clustering, gap analysis, focus mode.
- **Fine-grained matching:** cooldown, warmup, probability, refine keys, cascade links, per-entry injection overrides, entry decay.
- **Bootstrap entries:** seed and bootstrap injection for early conversations on new chats.
- **Persistent infrastructure:** IndexedDB cache, reuse-sync indexing (skips re-parse of unchanged entries), AI search circuit breaker, prompt cache optimization.
- **Diagnostics:** analytics, health check, pipeline inspector, activation simulation, "Why Not?" tracing, entry browser.

## Prerequisites

- **SillyTavern 1.12.14+**
- **Obsidian** with the **Local REST API** plugin enabled
- A lore vault. Your existing Obsidian vault works; `/dle-import` converts World Info JSON if you're migrating.
- For AI search: any LLM provider via SillyTavern's Connection Manager, or Custom Proxy mode through ST's CORS proxy. Keywords-only mode runs without any provider.

## Wiki pages

| Page | Description |
|------|-------------|
| [[What is DeepLore]] | What a lorebook is, why DeepLore, and how the pipeline works (start here) |
| [[Installation]] | Step-by-step setup guide |
| [[Quick Start]] | 5-minute getting started guide |
| [[First Steps]] | Building your vault and tuning the extension |
| [[For World Info Users]] | Field-by-field cheat sheet for migrating from World Info |
| [[Features]] | Linked catalog of all features |
| | |
| **Feature pages** | |
| [[Drawer]] | Live side panel: Why?, Browse, Gating, Librarian, Tools tabs, temperature heatmap |
| [[Inspection and Diagnostics]] | Context Cartographer, "Why Not?" tracing, health check, simulation |
| [[AI-Powered Tools]] | Session Scribe, Auto Lorebook, Optimize Keys, Auto-Summary |
| [[Entry Matching and Behavior]] | Cooldown, warmup, gating, fuzzy search, decay, cascade links |
| [[Injection and Context Control]] | Injection positions, Prompt Manager integration, pin and block, contextual gating |
| [[Custom Fields]] | User-defined frontmatter fields for contextual gating |
| [[AI Notepad]] | AI-written private session notes; tag mode and extract mode |
| [[Infrastructure]] | Multi-vault, IndexedDB cache, circuit breaker, AI caching |
| [[Setup and Import]] | Setup wizard, quick actions, World Info import |
| [[Setup Wizard]] | First-run configuration wizard |
| | |
| **Reference** | |
| [[Writing Vault Entries]] | How to author lorebook entries with copy-paste templates |
| [[AI Search]] | How AI selection works inside the pipeline |
| [[Pipeline]] | The full retrieval and gating flow |
| [[Settings Reference]] | Every setting documented |
| [[Slash Commands]] | All slash commands |
| [[Glossary]] | Key terms and definitions |
| [[Troubleshooting]] | Common issues and fixes |
| [[FAQ]] | Frequently asked questions |
