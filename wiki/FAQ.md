# Frequently Asked Questions

## General

### Do I need Obsidian?
Yes. DeepLore Enhanced uses Obsidian as its vault — your lore entries are stored as markdown files in an Obsidian vault. You'll need the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled in Obsidian for DeepLore to communicate with your vault.

### Do I need AI search? Can I just use keywords?
AI search is optional. You can run in **Keyword Only** mode, which matches entries purely by trigger keywords in the chat. AI search adds a second stage that picks the most relevant entries from keyword matches, catching things keywords miss — but it works fine without it.

### What AI providers work with AI search?
Any provider that SillyTavern's Connection Manager supports: Anthropic, OpenAI, OpenRouter, Google, Cohere, Mistral, local models via Oobabooga/KoboldCpp, and more. Just create a Connection Manager profile and select it in AI Search settings.

### What model should I use for AI search?
A fast, cheap model works best — the AI search prompt is lightweight and doesn't need a powerful model. **Claude Haiku** or **GPT-4o-mini** are good choices. The model only reads entry summaries and picks which ones are relevant; it doesn't generate creative text.

### How big can my vault be?
DeepLore has been tested with 200+ entry vaults and works well. For vaults with 40+ entries, hierarchical clustering automatically kicks in to keep AI search efficient. Extremely large vaults (1000+) may cause slower index builds but should still work.

### Does this cost money?
Only if you use AI search. Each generation makes one API call (sometimes two for large vaults with hierarchical clustering). With a cheap model like Claude Haiku, costs are typically fractions of a cent per message. Keyword-only mode is completely free. The sliding window cache also reduces API calls by reusing results when only new messages are added.

### Can I use this on mobile?
If you're running SillyTavern on a remote server and accessing it from a mobile browser, DeepLore will work — but Obsidian needs to be running on the same machine as SillyTavern (or accessible via network). The most common setup is a local desktop with both SillyTavern and Obsidian running.

## Lore Writing

### How do I make an entry a lorebook entry?
Add the lorebook tag to your note's frontmatter. By default, the tag is `lorebook`:

```yaml
---
tags:
  - lorebook
keys:
  - trigger keyword
  - another keyword
---
```

See [Writing Vault Entries](Writing-Vault-Entries) for the full guide.

### What's the difference between constants, seeds, and starter entries?
- **Constants** (tag: `lorebook-always`) — Always injected, every message, no matter what. Use for critical world rules.
- **Seeds** (tag: `lorebook-seed`) — Their content is sent to the AI search as story context, helping the AI understand your world when selecting entries. Not injected into the prompt directly.
- **Starter entries** (tag: `lorebook-bootstrap`) — Force-injected during the first few messages of a new chat (configurable threshold), ensuring the AI has baseline world info before keywords have a chance to fire.

### How do summaries work? Do I need them?
The `summary` field in frontmatter is used **only** for AI search — it helps the AI decide whether an entry is relevant. It's not injected into the writing AI's context (the full content handles that). If you're using keyword-only mode, summaries aren't used. If you use AI search, entries without summaries can still be selected, but summaries significantly improve accuracy. Run `/dle-summarize` to auto-generate them.

### Can I organize entries in folders?
Yes. DeepLore scans your entire vault (recursively) for notes with the lorebook tag. Folder structure doesn't matter — organize however you like in Obsidian.

## Troubleshooting

### My entries aren't injecting
Run `/dle-health` first — it catches most problems. Common causes:
1. Missing lorebook tag on entries
2. Scan depth too low (keywords not reaching far enough in chat)
3. Token budget full (too many entries trying to inject)
4. Gating rules blocking entries (requires/excludes/era/location)

See [Troubleshooting](Troubleshooting) for detailed diagnostics.

### The AI keeps picking the wrong entries
- Write better `summary` fields that explain **when** to select the entry, not what it contains
- Increase scan depth so the AI sees more chat context
- Try Two-Stage mode instead of AI-only — keywords pre-filter so the AI has fewer candidates to choose from
- Use `/dle-inspect` after a generation to see exactly what the AI received and selected

### "Open in Obsidian" links aren't working
The vault connection **Name** in DLE settings must match your Obsidian vault name exactly. If that's correct, try restarting Obsidian — the deep link handler can become unresponsive after long sessions or updates. See [Troubleshooting — Deep Links](Troubleshooting#deep-links-open-in-obsidian) for full steps.

### How do I see what DeepLore injected?
Three ways:
1. **Context Cartographer** — Click the lore sources button on any AI message to see exactly what was injected
2. **`/dle-inspect`** — Shows the full pipeline trace from the last generation
3. **Live Drawer** — The "Why?" tab shows injected entries in real time

## vs. Built-in World Info

### How is this different from SillyTavern's World Info?
SillyTavern's built-in World Info does keyword matching from a JSON file. DeepLore Enhanced adds:
- **AI-powered selection** that catches contextual relevance beyond keywords
- **Obsidian as your editor** with backlinks, templates, and graph views
- **Multi-vault support** for organizing different worlds or campaigns
- **Per-chat control** with pins, blocks, and contextual gating
- **Visual diagnostics** with relationship graphs, activation simulations, and a live drawer
- **Automatic tools** like auto-suggest, keyword optimization, and session summaries

### Can I import my existing SillyTavern lorebooks?
Yes. Run `/dle-import` to convert World Info JSON exports into Obsidian vault notes with proper frontmatter. It handles standard WI exports, V2 character cards, and entry arrays.

### Can I use both at the same time?
You can, but it's not recommended. Both systems inject lore into the prompt, so you'd be using double the token budget. If you want to migrate, import your World Info with `/dle-import` and then disable the built-in World Info.
