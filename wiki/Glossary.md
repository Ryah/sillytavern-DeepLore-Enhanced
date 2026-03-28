# Glossary

Key terms used throughout DeepLore Enhanced documentation and UI.

## Core Concepts

**Vault Index**
The in-memory collection of all parsed lorebook entries from your connected Obsidian vaults. Rebuilt on refresh or when cache expires. See [[Pipeline#Index Refresh]].

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
The full sequence of steps DeepLore runs on each generation: index refresh → keyword matching → AI selection → gating → formatting → injection. See [[Pipeline]] for the full flow diagram.

**Scan Depth**
How many recent chat messages DeepLore searches for keywords. A scan depth of 4 means the last 4 messages are scanned.

**Keyword Matching**
The first stage of entry selection. Scans recent chat messages for keywords defined in each entry's `keys:` field.

**AI Search**
The second stage (optional). An AI model evaluates keyword-matched candidates (or the full vault in AI-only mode) and selects the most relevant entries. See [[AI Search]].

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
Filtering based on narrative context using gating fields. Ships with four default fields (era, location, scene type, present characters), but users can define additional custom fields via the "Manage Fields" rule builder. Field definitions are stored in `DeepLore/field-definitions.yaml` in the vault. Set fields via `/dle-set-field <name> [value]` or the built-in aliases (`/dle-set-era`, `/dle-set-location`, etc.). See [[Features#Contextual Gating]].

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
An AI feature that periodically summarizes the chat and writes the summary to an Obsidian note. Useful for maintaining session continuity. See [[Features#Session Scribe]].

**Author's Notebook**
A per-chat scratchpad whose contents are injected into every generation as a system message. Use for character notes, plot reminders, or writing instructions.

**Auto Lorebook**
An AI feature that analyzes the chat and suggests new lorebook entries to create in your vault.

**Context Cartographer**
A UI feature that shows which entries were injected into each AI response. Appears as a "Lore Sources" button on chat messages. See [[Features#Context Cartographer]].

## UI

**Drawer**
A persistent side panel showing live pipeline feedback during chat. Displays which entries were injected, why they matched, token usage, and vault statistics in real-time. Contains four tabs: Why?, Browse, Gating, and Tools. See [[Drawer]].

**Temperature Heatmap**
Color-coded visual indicator in the Browse tab showing entry injection frequency relative to the vault average. Hot entries (red tint) are injected more often than average; cold entries (blue tint) are injected less often or never.

**Virtual Scroll**
A rendering optimization in the Browse tab that only displays visible rows in a long list, enabling smooth handling of vaults with 100+ entries.

**Overlay Mode**
A responsive layout mode where the Drawer converts to a dismissible overlay on narrow screens (when chat width exceeds 60% of the viewport).

## Infrastructure

**Circuit Breaker**
An automatic protection that stops making requests to a service after repeated failures, preventing request floods. DLE uses two circuit breakers: one per Obsidian vault (keyed by host:port, 2s-15s exponential backoff) and one for the AI service (2 failures to trip, 30s cooldown).

**IndexedDB Cache**
Browser-side persistent storage used to cache the vault index. Enables instant page load without waiting for Obsidian — the index is hydrated from cache, then validated in the background.

**Reuse Sync**
An optimization where all files are fetched from Obsidian, but unchanged entries (detected by content hash) skip re-parsing and tokenization. The savings come from avoiding the expensive parse/tokenize step, not from reducing network calls.

**Cache TTL**
Time-to-live for the vault index cache, in seconds. After this period, the index is refreshed from Obsidian on the next generation.

**Chat Epoch**
An internal counter that increments on every chat switch. Prevents stale data from one chat from being written to another.

**Generation Lock**
An exclusive lock acquired before each pipeline run, preventing concurrent pipelines from executing. Has a 90-second stale timeout for auto-recovery if a pipeline crashes.

**Epoch Guard**
A race condition prevention mechanism using two epoch counters (`chatEpoch` and `generationLockEpoch`). If either epoch changes mid-pipeline, the pipeline discards its results — they belong to a stale context.

**AI Throttle**
A rate limiter enforcing a 2-second minimum delay between consecutive AI search API calls. Prevents request flooding during rapid regenerations. Throttled calls fall back to keyword results without tripping the circuit breaker.

**Sliding Window Cache**
A caching strategy for AI search results. Reuses cached results when the vault manifest is unchanged and new chat messages don't mention any vault entity names or keys. Regenerations and swipes always reuse cached results.

## Entry Metadata

**Priority**
A number controlling injection order. Lower = higher priority. Suggested ranges: 20 (inner circle), 35 (core lore), 50 (standard), 60+ (secondary/flavor).

**Cooldown**
Number of generations an entry is suppressed after being injected. Important: the AI does NOT remember lore from prior generations — during the cooldown, the AI has no access to this entry's content. Use for rotating flavor/variety entries, not for entries the AI needs consistently.

**Warmup**
Minimum keyword hit count required before an entry triggers. The warmup threshold is checked every generation — the keyword must meet the hit count each time, not just the first time. Prevents entries from activating on a single casual mention.

**Probability**
Chance (0.0-1.0) that a matched entry actually triggers. Use for variety — e.g., 0.5 means the entry injects ~50% of the time it matches.

**Entry Decay**
Tracks how many generations pass since each entry was last injected. Stale entries get a freshness boost in the AI manifest; frequently injected entries get a penalty. Helps rotate lore naturally. See [[Features#Entry Decay & Freshness]].

**Refine Keys**
A secondary AND filter (`refine_keys` in frontmatter) that requires at least one refine key to also appear in the scan text before the entry triggers. Reduces false positives for entries with common primary keywords. See [[Features#Refine Keys]].

**Cascade Links**
Unconditional entry links (`cascade_links` in frontmatter). When an entry matches, all entries listed in its cascade links are automatically pulled in without any keyword check. See [[Features#Cascade Links]].

**Fuzzy Search (BM25)**
An optional supplement to keyword matching that uses BM25/TF-IDF scoring to find entries with partial or approximate keyword matches. Enable in [[Settings Reference|Matching & Budget settings]].

**Wikilinks**
Obsidian-style `[[links]]` in entry content that reference other entries. DeepLore resolves these to actual entry titles for recursive matching.
