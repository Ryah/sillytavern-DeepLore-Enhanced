# Features

This page covers all of DeepLore Enhanced's features in detail. For the core matching pipeline, see [[Pipeline]]. For AI Search specifics, see [[AI Search]].

## Context Cartographer

Adds a book icon button to each AI message's action bar. Click it to see which vault entries were injected for that message, why they matched, and how much context they used.

**The popup shows:**
- Entry name (clickable link to Obsidian if vault name is configured)
- Match type: keyword, AI (with confidence and reason), or constant
- Priority value
- Estimated token cost

**Setup:**
1. Enable "Show Lore Sources Button" in [[Settings Reference|Context Cartographer settings]]
2. Optionally set your "Obsidian Vault Name" to enable deep links that open entries directly in Obsidian

**Notes:**
- Source data is saved per-message in `message.extra.deeplore_sources`, so it persists across sessions
- The book icon only appears on messages that have lore source data

---

## Session Scribe

Automatically summarizes your roleplay sessions and writes them as timestamped markdown notes to your Obsidian vault.

**How it works:**
1. Tracks actual chat position — after every N new messages (configurable), Scribe generates a summary
2. The summary is written as a markdown file to the configured Session Folder in your vault
3. Notes include frontmatter with timestamp, character name, and chat ID
4. Each summary builds on the previous one — the prior note is fed as context so the AI doesn't repeat itself

**On-demand:** Use `/dle-scribe` to write a summary at any time. Optionally pass a focus topic: `/dle-scribe What happened during the trial?`

**Connection options:**
- **SillyTavern** (default): Uses your active AI connection via generateQuietPrompt
- **Connection Profile**: Use any saved Connection Manager profile — lets you route summaries through a different model/provider
- **Custom Proxy**: Use a separate proxy server (claude-code-proxy or compatible Anthropic Messages API endpoint)

**Setup:**
1. Enable "Enable Session Scribe" in [[Settings Reference|Session Scribe settings]]
2. Set the auto-scribe interval (every N messages)
3. Set the Session Folder (default: `Sessions`)
4. Choose a connection mode (SillyTavern, Connection Profile, or Custom Proxy)
5. Optionally customize the summary prompt and message window depth

**Notes:**
- Requires the server plugin to be installed (it handles writing to the vault)
- Default prompt covers events, character dynamics, revelations, and state changes in past tense
- Configurable message window (default: 20 messages) and response token limit (default: 1024)

---

## Vault Change Detection & Auto-Sync

When the index rebuilds, DeepLore compares the new index against the previous one and reports changes.

**Detects:**
- New entries added
- Entries removed
- Modified content
- Changed keywords

**Auto-Sync Polling:** Set "Auto-Sync Interval" to automatically re-check the vault every N seconds. When changes are detected, toast notifications summarize what changed (if "Show Sync Change Toasts" is enabled).

**Manual refresh:** Click "Refresh Index" in settings or use `/dle-refresh`.

---

## Cooldown Tags

Per-entry `cooldown: N` in frontmatter. After an entry triggers, it's skipped for the next N generations before becoming eligible again.

**Use case:** Prevent the same lore from being re-injected every single generation. Useful for flavor text or background entries that don't need constant repetition.

**Example:**
```yaml
cooldown: 3  # After triggering, skip for 3 generations
```

**Notes:**
- Cooldown is tracked per-session (resets on chat change or page refresh)
- Constants (`#lorebook-always`) are exempt from cooldown

---

## Warmup Tags

Per-entry `warmup: N` in frontmatter. An entry's keywords must appear N or more times in the scan text before it triggers for the first time.

**Use case:** Prevent entries from triggering on a single casual mention. Ensure a topic is being discussed in depth before injecting detailed lore.

**Example:**
```yaml
warmup: 3  # Keyword must appear 3+ times in scan text before first trigger
```

**Notes:**
- Only affects the first trigger. Once an entry has triggered, it matches normally afterward.
- Count is based on occurrences in the scan text, not unique messages

---

## Re-injection Cooldown

Global setting (not per-entry). Skips re-injecting an entry for N generations after it was last injected. Helps save context by avoiding redundant lore repetition.

**Setup:** Set "Re-injection Cooldown" in [[Settings Reference|Matching & Budget settings]] (0 = disabled)

**Notes:**
- Constants (`#lorebook-always`) are exempt
- Tracked per-session (resets on chat change)

---

## Active Character Boost

When enabled, automatically matches the active character's vault entry by name or keyword, even if the character isn't mentioned in recent chat messages.

**Use case:** Ensure the character you're roleplaying with always has their lore available, without relying on their name appearing in the most recent messages.

**Setup:** Check "Active Character Boost" in [[Settings Reference|Matching & Budget settings]]

---

## Conditional Gating

Entries can declare dependencies on other entries using `requires` and `excludes` frontmatter fields.

### requires
All listed entry titles must be in the matched set for this entry to activate.

```yaml
requires:
  - Eris
  - Dark Council
```
This entry only injects when both "Eris" and "Dark Council" are also matched.

### excludes
If any listed entry title is in the matched set, this entry is blocked.

```yaml
excludes:
  - Draft Notes
```
This entry is blocked if "Draft Notes" is matched.

### Cascading Resolution
Gating resolves iteratively. If Entry A requires Entry B, and Entry B gets removed by its own gating rules, Entry A is also removed. This cascading continues until no more entries are affected.

See [[Writing Vault Entries]] for a complete template.

---

## Refine Keys

Per-entry `refine_keys` in frontmatter. Adds a secondary AND filter on top of primary keyword matching. When set, at least one refine key must also appear in the scan text for the entry to trigger.

**Use case:** Reduce false positives for entries with common primary keywords. For example, a character named "Rose" might have `refine_keys` requiring mention of their faction or role to avoid triggering on every use of the word "rose."

**Example:**
```yaml
keys:
  - Rose
  - Rose Blackwood
refine_keys:
  - guild
  - spymaster
  - intelligence
```

See [[Writing Vault Entries]] for a complete template.

---

## Cascade Links

Per-entry `cascade_links` in frontmatter. When an entry matches, all entries listed in its `cascade_links` are automatically pulled in -- no keyword check needed for the linked entries.

**Use case:** Ensure related entries always travel together. Unlike wikilink recursion (which requires keyword matches), cascade links are unconditional.

**Example:**
```yaml
cascade_links: ["Soulbrand Removal", "Ironveil Guild"]
```

When this entry matches, "Soulbrand Removal" and "Ironveil Guild" are automatically included.

See [[Writing Vault Entries]] for a complete template.

---

## Per-Entry Injection Position

Entries can override the global injection position via frontmatter:

| Field | Values | Description |
|-------|--------|-------------|
| `position` | `before`, `after`, `in_chat` | Where to inject |
| `depth` | number | Chat depth (for `in_chat`) |
| `role` | `system`, `user`, `assistant` | Message role (for `in_chat`) |

Entries are grouped by their effective position (global default or override) and each group is injected separately.

**Example:** You might want most lore injected at depth 4 as system messages, but a character's dialogue hints injected at depth 1 as user messages.

See [[Writing Vault Entries]] for templates.

---

## New Chat Features

On a brand new chat (below the New Chat Threshold, default 3 messages), two features help bootstrap the conversation:

### Seed Entries (`#lorebook-seed`)
- Entry content is sent to the AI as additional story context alongside the chat
- Helps the AI understand your setting and make better entry selections from minimal context
- NOT injected into the writing AI's context. Only informs AI search.
- When seed mode is active, AI is instructed to fill to maxEntries selections (more aggressive)

### Bootstrap Entries (`#lorebook-bootstrap`)
- Force-injected like constants when chat is short
- Once chat grows past the threshold, they become regular entries managed by normal selection
- Good for writing instructions or foundational lore needed at the start

An entry can have both tags: its content feeds the AI (seed) AND it force-injects (bootstrap).

---

## Entry Analytics

Track how often each entry is matched and injected across generations. View with `/dle-analytics`.

**Shows:**
- Table sorted by injection count
- "Never Injected" section for dead entry detection

**Use case:** Identify entries with bad keywords that never trigger, or entries that trigger too frequently.

---

## Entry Health Check

Audit all vault entries for common issues with `/dle-health`.

**Checks:**
- Empty keys on non-constant entries
- Orphaned `requires`/`excludes` references
- Oversized entries (>1500 tokens)
- Duplicate keywords shared across entries
- Missing AI selection summaries

---

## Pipeline Inspector

View a detailed trace of the last generation with `/dle-inspect`.

**Shows:**
- Pipeline mode (two-stage, ai-only, keywords-only)
- Keyword matches with trigger keywords
- AI selections with confidence and reasons
- Fallback status
- Constants and bootstrap entries

See [[Slash Commands]] for all available commands.
