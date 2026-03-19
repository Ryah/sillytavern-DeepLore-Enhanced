# DeepLore Enhanced

**AI-Powered Obsidian Vault Lorebook for SillyTavern**

DeepLore Enhanced connects your [Obsidian](https://obsidian.md/) vault to [SillyTavern](https://github.com/SillyTavern/SillyTavern), automatically injecting relevant lore entries into your AI prompts. It combines keyword matching with AI-powered semantic search to find entries that are contextually relevant to your conversation, even when no exact keywords match.

> **Looking for the base version?** [DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) is the stable, keyword-only version recommended for most users. DeepLore Enhanced is a superset that adds AI search and advanced features.

> **Do NOT run both.** Running DeepLore and DeepLore Enhanced simultaneously will cause conflicts. Pick one.

## Key Features

- **Two-stage pipeline:** Keywords pre-filter, then AI selects the best matches
- **Any AI provider:** Works with Anthropic, OpenAI, OpenRouter, or any provider via SillyTavern's Connection Manager
- **Multi-vault support:** Connect multiple Obsidian vaults, merged into a single index
- **AI Notebook:** Persistent per-chat scratchpad injected every turn
- **Entry Browser:** Searchable popup of all entries with content preview and analytics
- **Relationship Graph:** Interactive force-directed visualization of entry connections
- **Context Cartographer:** Token bar charts, injection grouping, vault attribution
- **Session Scribe:** Auto-summarize sessions with timeline view
- **Auto Lorebook:** AI suggests new entries from chat context
- **Keyword Optimizer:** AI-powered keyword suggestions
- **Activation Simulation:** Replay chat history to see trigger patterns
- **"Why Not?" Diagnostics:** Click unmatched entries to see why they didn't fire
- **Self-healing health checks:** 30+ automated checks with auto-run on load
- **Probability frontmatter:** Per-entry random trigger chance
- **Injection deduplication:** Skip re-injecting recently used entries
- **Conditional gating / per-entry injection / cooldown / warmup**
- **Vault sync / seed & bootstrap / analytics / pipeline inspector**

## Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) 1.12.0+
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin
- Server plugins enabled in SillyTavern (`enableServerPlugins: true`)
- For AI search: a saved Connection Manager profile in SillyTavern (any provider), or [claude-code-proxy](https://github.com/horselock/claude-code-proxy)

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
