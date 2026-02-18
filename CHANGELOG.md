# Changelog

## 0.9-ALPHA

### AI Search Pipeline Overhaul
- **Richer manifest entries** -- Each entry now includes tags, wiki-link cross-references ("Links to:"), token cost, and longer summaries (400 chars, configurable up to 800). Gives the AI dramatically more context per entry.
- **Wiki-link relationship extraction** -- Links between entries (`[[Eris]]`, `[[Dark Council|the council]]`) are now extracted before content cleaning and resolved to confirmed entry titles. Included in the manifest as "Links to:" lines.
- **Structured AI responses** -- AI now returns confidence levels (high/medium/low) and reasons for each pick instead of a flat title list. Context Cartographer popup shows these reasons directly.
- **Confidence-based priority** -- High-confidence AI picks get no priority penalty (same as keyword matches), medium gets 1x offset, low gets 2x offset. Naturally pushes uncertain picks below certain ones.
- **Annotated chat context** -- Messages sent to the AI now include `(user)` / `(character)` role annotations to clarify who said what.
- **Improved system prompt** -- Ranked selection criteria, mentions relationships and token costs, asks for structured output with reasons.
- **Manifest header** -- AI receives entry count and budget context alongside the manifest.
- **Configurable summary length** -- New "Manifest Summary Length" setting (100-800 chars) in AI Search section.
- **Backward compatible** -- Legacy flat array responses still work. Old server responses with `titles` field handled gracefully alongside new `results` field.

### Internal
- New functions: `extractWikiLinks()`, `resolveLinks()`, `buildAiChatContext()`
- VaultEntry now carries `links`, `resolvedLinks`, and `tags` fields
- Server: `extractJsonArray` replaced with `extractAiResponse` + `normalizeResults` supporting both formats
- Bumped version to 0.9-ALPHA

## 0.8-ALPHA

### New Features
- **Context Cartographer** -- Adds a book icon button to each AI message's action bar. Click it to see which vault entries were injected, why they matched, their priority, and token cost. Configurable Obsidian vault name enables clickable deep links that open entries directly in Obsidian.
- **Session Scribe** -- Automatically summarizes roleplay sessions and writes them to your Obsidian vault as timestamped markdown notes with frontmatter. Triggers after every N AI messages (configurable). Also available on demand via `/dle-scribe`, with optional focus topics.
- **`/dle-scribe` slash command** -- Write a session summary on demand. Optionally provide a focus topic, e.g. `/dle-scribe What happened with the sword?`
- **Obsidian write support** -- New server plugin route (`POST /write-note`) enables writing markdown notes back to the vault.

### Settings
- New "Obsidian Vault Name" field in Connection settings for deep links.
- New "Show Lore Sources Button" toggle in Injection settings.
- New "Session Scribe" settings section: enable toggle, auto-scribe interval, session folder, custom summary prompt.

### Internal
- Lore source data persisted in `message.extra.deeplore_sources` for per-message tracking across sessions.
- Bumped version to 0.8-ALPHA.

## 0.7-ALPHA

### Improvements
- **Accurate token counting** -- Uses SillyTavern's built-in tokenizer instead of the rough `length / 3.5` estimate. Token budgets and stats are now much more accurate. Falls back to estimation if the tokenizer is unavailable.
- **Better recursive scanning** -- Recursive matching now only scans content from newly matched entries each step, avoiding redundant work and preventing wasted cycles when entries reference each other.
- **Sentence-aware manifest truncation** -- AI search manifest summaries now cut at sentence boundaries instead of mid-word, giving the AI better context for entry selection.
- **Runtime settings validation** -- All numeric settings (including AI search settings) are clamped to valid ranges on load and save. Invalid values are corrected automatically.
- **Added package.json** -- Provides version tracking and repository metadata.
- **Added unit tests** -- Test coverage for frontmatter parsing, content cleaning, title extraction, keyword matching, sentence truncation, hash function, and settings validation. Run with `node tests.js`.

### Internal
- Bumped version to 0.7-ALPHA.

## 0.6-ALPHA

- Initial public release.
- Keyword-triggered lorebook injection from Obsidian vault.
- AI-powered semantic search via Claude Haiku.
- Recursive scanning, token budgets, configurable injection.
- Server installer scripts.
