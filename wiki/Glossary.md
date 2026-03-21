# Glossary

Key terms used throughout DeepLore Enhanced documentation and UI.

## Core Concepts

**Vault Index**
The in-memory collection of all parsed lorebook entries from your connected Obsidian vaults. Rebuilt on refresh or when cache expires.

**Entry / Vault Entry**
A single Obsidian note that has been parsed into a lorebook entry. Contains frontmatter metadata (keys, priority, summary, etc.) and markdown content.

**Lorebook Tag**
The Obsidian tag (default: `lorebook`) that marks a note for indexing. Only notes with this tag are included in the vault index.

**Constant**
An entry tagged with `lorebook-always` that is injected into every generation, regardless of keyword matches. Use sparingly — each one consumes context budget permanently.

**Seed Entry**
An entry tagged with `lorebook-seed` whose content is sent to the AI search as story context on new chats. Helps the AI make better entry selections. Not injected into the writing AI.

**Bootstrap Entry**
An entry tagged with `lorebook-bootstrap` that force-injects when the chat is short (below the new chat threshold), then becomes a regular triggered entry.

## Pipeline & Matching

**Pipeline**
The full sequence of steps DeepLore runs on each generation: index refresh → keyword matching → AI selection → gating → formatting → injection.

**Scan Depth**
How many recent chat messages DeepLore searches for keywords. A scan depth of 4 means the last 4 messages are scanned.

**Keyword Matching**
The first stage of entry selection. Scans recent chat messages for keywords defined in each entry's `keys:` field.

**AI Search**
The second stage (optional). An AI model evaluates keyword-matched candidates (or the full vault in AI-only mode) and selects the most relevant entries.

**Two-Stage Mode**
The recommended search mode: keywords pre-filter candidates, then AI picks the best matches. Balances cost and quality.

**Manifest**
The compressed representation of candidate entries sent to the AI search model. Contains entry titles, token counts, links, and summaries.

**Hierarchical Pre-Filter**
For large candidate sets (40+), entries are clustered by category and the AI selects relevant categories first, then individual entries within those categories.

## Gating & Filtering

**Gating**
Rules that prevent entries from being injected even after they match. Includes requires/excludes rules and contextual gating.

**Requires**
A frontmatter field listing entry titles that must ALL be matched for this entry to inject. Example: `requires: [Dark Council]` means this entry only injects if "Dark Council" is also matched.

**Excludes**
A frontmatter field listing entry titles that BLOCK this entry. If any excluded entry is matched, this entry is filtered out.

**Contextual Gating**
Filtering based on narrative context: era, location, scene type, and present characters. Set via `/dle-set-era`, `/dle-set-location`, etc.

**Pin**
A per-chat override that forces an entry to always inject, bypassing keyword matching and gating. Set via `/dle-pin <name>`.

**Block**
A per-chat override that prevents an entry from ever injecting, even if it matches. Overrides constants. Set via `/dle-block <name>`.

## Injection

**Injection Position**
Where in the prompt the entry content is placed: `before` (before the main prompt), `after` (after), or `in_chat` (inserted between chat messages at a specific depth).

**Injection Depth**
For `in_chat` position, how many messages from the bottom the entry is inserted. Depth 0 = right before the last message.

**Injection Role**
The message role used for the injected content: `system`, `user`, or `assistant`.

**Token Budget**
The maximum number of tokens DeepLore can inject per generation. Entries are selected by priority until the budget is exhausted.

**Prompt List Mode**
An alternative injection mode where entries register as Prompt Manager entries. Users can drag them to any position in the prompt order.

## AI Features

**Connection Profile**
A SillyTavern Connection Manager profile used for AI search, Scribe, or Auto Lorebook. Configures which API provider and model to use.

**Session Scribe**
An AI feature that periodically summarizes the chat and writes the summary to an Obsidian note. Useful for maintaining session continuity.

**AI Notebook**
A per-chat scratchpad whose contents are injected into every generation as a system message. Use for character notes, plot reminders, or writing instructions.

**Auto Lorebook**
An AI feature that analyzes the chat and suggests new lorebook entries to create in your vault.

**Context Cartographer**
A UI feature that shows which entries were injected into each AI response. Appears as a "Lore Sources" button on chat messages.

## Infrastructure

**Circuit Breaker**
An automatic protection that stops making requests to an Obsidian vault after repeated failures, preventing request floods. Auto-recovers after a backoff period.

**IndexedDB Cache**
Browser-side persistent storage used to cache the vault index. Enables instant page load without waiting for Obsidian — the index is hydrated from cache, then validated in the background.

**Delta Sync**
An optimization where only changed files are re-fetched from Obsidian instead of the full vault. Reduces sync time for large vaults.

**Cache TTL**
Time-to-live for the vault index cache, in seconds. After this period, the index is refreshed from Obsidian on the next generation.

**Chat Epoch**
An internal counter that increments on every chat switch. Prevents stale data from one chat from being written to another.

## Entry Metadata

**Priority**
A number controlling injection order. Lower = higher priority. Suggested ranges: 20 (inner circle), 35 (core lore), 50 (standard), 60+ (secondary/flavor).

**Cooldown**
Number of generations an entry skips after being injected. Prevents repetitive injection of the same entry.

**Warmup**
Minimum keyword hit count required before an entry triggers. Prevents entries from activating on a single casual mention.

**Probability**
Chance (0.0-1.0) that a matched entry actually triggers. Use for variety — e.g., 0.5 means the entry injects ~50% of the time it matches.

**Wikilinks**
Obsidian-style `[[links]]` in entry content that reference other entries. DeepLore resolves these to actual entry titles for recursive matching.
