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
1. After every N AI messages (configurable), Scribe generates a summary using your AI connection
2. The summary is written as a markdown file to the configured Session Folder in your vault
3. Notes include frontmatter with timestamp, character name, and chat ID

**On-demand:** Use `/dle-scribe` to write a summary at any time. Optionally pass a focus topic: `/dle-scribe What happened during the trial?`

**Setup:**
1. Enable "Enable Session Scribe" in [[Settings Reference|Session Scribe settings]]
2. Set the auto-scribe interval (every N messages)
3. Set the Session Folder (default: `Sessions`)
4. Optionally customize the summary prompt

**Notes:**
- Requires the server plugin to be installed (it handles writing to the vault)
- Uses your current AI connection (same as AI Search)
- Default prompt summarizes events, character changes, and plot developments as bullet points

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

**30+ checks** across categories: Settings, Entry Config, Gating, Size, AI Search, Keywords, Injection, Links. Includes:
- Empty keys on non-constant entries
- Orphaned `requires`/`excludes` references
- Circular requires detection
- Duplicate titles across vaults
- Orphaned cascade links
- Conflicting requires/excludes
- Cooldown on constants
- Depth override without in_chat position
- No enabled vaults
- And many more

Auto-runs on extension load, surfaces errors/warnings via toast.

---

## AI Notebook

Persistent per-chat scratchpad that is injected into every generation when enabled. Use for character notes, plot threads, reminders, or anything the AI should always know.

**Usage:** `/dle-notebook` opens the editor popup with a token counter. Content is saved in chat metadata and survives page reloads.

**Setup:** Enable in settings, configure injection position/depth/role.

---

## Entry Browser

`/dle-browse` opens a searchable, filterable popup of all indexed entries with full content preview, analytics usage stats, and Obsidian deep links.

**Features:**
- Search by title, keywords, or content
- Filter by status (constant, seed, bootstrap, regular)
- Filter by tag
- Expandable full content preview
- Priority, token count, and usage stats
- Vault attribution when multi-vault is active

---

## Entry Relationship Graph

`/dle-graph` visualizes entry relationships as an interactive force-directed graph on a canvas.

**Shows:**
- Nodes colored by type (regular, constant, seed, bootstrap)
- Edges for wiki-links, requires, excludes, and cascade links
- Circular dependency detection with warnings
- Hover tooltips with entry details and connection count
- Vault attribution in multi-vault mode

**Interaction:** Drag nodes to reposition, scroll to zoom, hover for details.

---

## "Why Not?" Diagnostics

In the Test Match popup, unmatched entries are clickable. Click one to see exactly why it didn't fire:

**Diagnosis stages:**
1. No keywords defined
2. Scan depth is zero
3. Keyword miss (no keywords found in scan text)
4. Refine keys not met
5. Warmup threshold not reached
6. Probability roll failed
7. Cooldown active
8. Re-injection cooldown active
9. Gating: requires not met
10. Gating: excluded by another entry
11. AI rejected (two-stage mode)
12. Budget cut

Each diagnosis includes specific suggestions for fixing the issue.

---

## Injection Deduplication

Opt-in setting that tracks which entries were injected in recent generations and skips re-injecting them. Helps save context budget by avoiding redundant lore.

**Setup:** Enable "Strip Duplicate Injections" in settings and set the lookback depth (how many recent generations to check).

**Notes:**
- Constants are exempt
- Tracked per-chat session (resets on chat change)
- Injection history is saved in chat metadata

---

## Auto Lorebook Creation

AI analyzes chat for characters, locations, items, or concepts that are mentioned but don't have lorebook entries. Suggests new entries with a human review gate.

**Usage:** `/dle-suggest` or auto-trigger every N messages.

**Features:**
- Per-suggestion cards with title, type, keywords, summary, and content preview
- Accept/Reject buttons per suggestion
- Accepted entries are written to Obsidian with proper frontmatter
- Configurable AI connection (ST, profile, or proxy)

---

## Optimize Keywords

`/dle-optimize-keys [name]` sends an entry to AI for keyword suggestions.

**Mode-aware:** In keyword-only mode, suggests precise terms. In two-stage mode, suggests broader terms since AI will filter later.

**Features:**
- Side-by-side comparison of current vs suggested keywords
- AI reasoning for changes
- Accept button writes updated keywords back to Obsidian

---

## Activation Simulation

`/dle-simulate` replays chat history step-by-step, showing which entries activate and deactivate at each message. Useful for understanding how entries trigger across a conversation.

**Shows:**
- Timeline with one row per message
- Green: newly activated entries
- Red: deactivated entries
- Active count at each step

---

## Scribe Session Timeline

`/dle-scribe-history` fetches all session notes from the configured scribe folder and displays them in a scrollable popup.

**Features:**
- Notes sorted by date (newest first)
- Click to expand full content
- Character name and date display
- Scribe context persists across page reloads via chat metadata

---

## Multi-Vault Support

Connect multiple Obsidian vaults with independent connection settings. Entries from all enabled vaults are merged into a single index.

**Features:**
- Dynamic vault list in settings (add/remove vaults)
- Per-vault enable/disable toggle
- Per-vault connection test
- Vault attribution shown in Entry Browser and Context Cartographer
- Auto-migration from legacy single-vault settings
- Entry writes (Scribe, Auto-Suggest, Optimize) use the first enabled vault

---

## Probability Frontmatter

Per-entry `probability` field (0.0-1.0). When an entry is matched by keywords, a random roll determines if it actually fires.

**Example:**
```yaml
probability: 0.5  # 50% chance of triggering when matched
```

**Notes:**
- Constants are always injected regardless of probability
- `probability: 0` effectively disables the entry (flagged by health check)
- `probability: 1` or omitting the field means always trigger

---

## Pipeline Inspector

View a detailed trace of the last generation with `/dle-inspect`.

**Shows:**
- Pipeline mode (two-stage, ai-only, keywords-only)
- Keyword matches with trigger keywords
- AI selections with confidence and reasons
- Fallback status
- Constants and bootstrap entries
- Probability-skipped entries

See [[Slash Commands]] for all available commands.
