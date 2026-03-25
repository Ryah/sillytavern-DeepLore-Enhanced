# Inspection & Diagnostics

Tools for understanding what DeepLore Enhanced is doing, why entries were or weren't injected, and how your vault is configured.

---

## Context Cartographer

Adds a book icon button to each AI message's action bar. Click it to see which vault entries were injected for that message, why they matched, and how much context they used.

**The popup shows:**
- Entry name (clickable link to Obsidian if vault connection names match Obsidian vault names)
- Match type: keyword, AI (with confidence and reason), constant, pinned, or bootstrap
- Priority value
- Token cost with color-gradient bar (green/yellow/red relative to vault average token size)
- Entries grouped by injection position (Before Main Prompt, In-chat @depth, After Main Prompt)
- Generation-to-generation diff: shows +new and -removed entries with reasons (e.g., "Bootstrap fall-off", "No longer matched")
- Expandable content preview (click to show first 300 chars with keyword highlighting)
- Vault source label (when multiple vaults are connected)
- Entry metadata: keys, requires, era, location, and wikilinks

**Setup:**
1. Enable "Show Lore Sources Button" in [[Settings Reference|Context Cartographer settings]]
2. Set vault connection names to match your Obsidian vault names exactly to enable deep links

**Notes:**
- Source data is saved per-message in `message.extra.deeplore_sources`, so it persists across sessions
- The book icon only appears on messages that have lore source data

---

## Pipeline Inspector

View a detailed trace of the last generation with `/dle-inspect`.

**Shows:**
- Pipeline mode (two-stage, ai-only, keywords-only)
- Keyword matches with trigger keywords
- AI selections with confidence and reasons
- Fallback status
- Constants and bootstrap entries
- Entries cut by budget or max entries cap
- Probability-skipped entries with their roll values
- Unmatched entries with "Why Not?" inline diagnostics (click to expand)

**When to use:** Debug why certain entries were or weren't injected in the last generation. The inspector shows the full picture: what matched, what the AI picked, and what got filtered out.

See [[Slash Commands]] for the `/dle-inspect` command reference.

---

## Entry Browser

Browse all indexed entries via the **Browse tab** in the [[Drawer]] panel, `/dle-browse` popup, or the "Browse" button in the Quick Actions bar.

**Features:**
- Search by title or keyword (300ms debounce)
- Filter by status: all, injected, pinned, blocked, constant, seed, bootstrap, never injected
- Filter by tag (dynamic dropdown from vault tags)
- Sort by priority (asc/desc), alphabetical (A-Z/Z-A), token count (asc/desc), or injection count (desc)
- Temperature heatmap coloring — entries tinted hot (red) or cold (blue) based on injection frequency relative to vault average
- Per-chat injection count badges (e.g., "3x")
- Expandable detail view with content preview, keywords, metadata, and Obsidian deep link
- Inline pin/block buttons per entry (per-chat overrides)
- Virtual scrolling for large vaults (100+ entries)
- "Why not injected?" diagnostics on unmatched entries (see below)

**When to use:** Quickly review your vault without switching to Obsidian. Good for checking keywords, priorities, token sizes, and injection patterns at a glance. The [[Drawer]] Browse tab provides the same functionality inline while chatting.

---

## "Why Not?" Diagnostics

When an entry has keywords but was not injected, you can find out exactly why. The "Why Not?" diagnostic traces the entry through every pipeline stage and tells you where it was filtered out.

**Where to access it:**
- In the **Entry Browser** (`/dle-browse`): Unmatched entries show a "Why not?" button. Click it to see the diagnosis inline.
- In the **Pipeline Inspector** (`/dle-inspect`): The "Unmatched entries with keywords" section at the bottom shows inline diagnostics for each entry. Click an entry to expand its diagnosis.

**Diagnostic stages:**

The `diagnoseEntry()` function checks each pipeline stage in order and stops at the first failure:

| Stage | What it means |
|-------|--------------|
| **no_keywords** | Entry has no trigger keywords defined |
| **scan_depth_zero** | Scan depth is 0, so keyword matching is disabled |
| **keyword_miss** | None of the entry's keywords appear in the last N messages. If a keyword appears in older messages, the suggestion will tell you to increase scan depth. |
| **refine_keys** | Primary keyword matched, but none of the refine keys were found (the AND filter blocked it) |
| **warmup** | Keyword was found but not enough times to meet the warmup threshold |
| **probability** | Entry was matched but rolled out by its probability setting |
| **cooldown** | Entry is in per-entry cooldown (N generations remaining) |
| **reinjection_cooldown** | Entry was injected recently and is blocked by the global re-injection cooldown |
| **gating_requires** | One or more required entries are not currently matched |
| **gating_excludes** | An excluded entry is currently matched, blocking this one |
| **ai_rejected** | Entry was in the AI candidate list but the AI chose not to select it |
| **budget_cut** | Entry matched all filters but was cut by the budget limit or max entries cap |

Each diagnosis includes a plain-language explanation and, where applicable, a suggestion for how to fix the issue (e.g., "Increase scan depth from 4 to reach it" or "Improve the entry summary to help the AI understand when to select it").

---

## Activation Simulation

Replay your chat history step-by-step with `/dle-simulate`, showing which entries activate and deactivate at each message.

**How it works:**
1. The simulation walks through your chat from message 1 to the end
2. At each message, it runs keyword matching against the entries (using your current scan depth and matching settings)
3. Constants are always active; bootstrap entries are active until the chat exceeds the New Chat Threshold
4. The timeline shows which entries turned on (+green) and off (-red) at each message boundary

**The popup shows:**
- A scrollable timeline with one row per message
- Speaker name and count of active entries
- Newly activated entries highlighted in green
- Deactivated entries highlighted in red
- Messages where nothing changed are shown with a muted border
- Copy button to export the timeline as plain text

**When to use:** Understand how your keywords behave across an entire conversation. Helps identify entries that:
- Trigger too early (keywords are too common)
- Trigger too late (keywords don't appear until deep into the conversation)
- Never trigger at all (keywords are wrong or too specific)
- Flicker on and off (keywords appear intermittently in the scan window)

**Notes:**
- The simulation uses keyword matching only (no AI search, no probability/warmup/cooldown) for a clean, deterministic view
- Per-entry scan depth overrides are respected
- Run after a conversation has some length to get a meaningful timeline

---

## Relationship Graph

Visualize entry relationships as an interactive force-directed graph with `/dle-graph`.

**Shows:**
- Nodes for each entry (color-coded by type/tags)
- Edges for wikilinks, requires/excludes connections, and cascade links
- Interactive: drag nodes, zoom, and pan to explore the graph

**When to use:** Explore the relationship structure of your vault. Identify clusters of related entries, orphaned entries with no connections, and long dependency chains.

**Notes:**
- Large vaults (200+ entries) may render slowly; the extension warns you before proceeding

---

## Entry Analytics

Track how often each entry is matched and injected across generations. View with `/dle-analytics`.

**Shows:**
- Table sorted by injection count
- Entry name, match count, injection count, last used timestamp
- "Never Injected" section for dead entry detection

**Use case:** Identify entries with bad keywords that never trigger, or entries that trigger too frequently.

**Notes:**
- Analytics persist in SillyTavern settings across sessions
- Resets when you clear settings or reinstall

---

## Entry Health Check

Audit all vault entries for common issues with `/dle-health`. Runs 30+ checks across multiple categories.

**Check categories:**
- **Multi-vault:** Enabled vaults, API key validation
- **Settings:** Scan depth disabled, AI mode without profile, proxy URL missing, budget too low, cache TTL, index staleness
- **Entry config:** Duplicate titles, empty keys, empty content, orphaned requires/excludes/cascade_links, requires + excludes same title, self-excluding entries, oversized entries (>1500 tokens), missing summary
- **Gating:** Circular requires, unresolved wiki-links, conflicting overrides
- **AI Search:** Entries without summary fields
- **Keywords:** Short keywords (2 chars or less), duplicate keywords across entries
- **Size:** Constants exceeding budget, seed entries >2000 tokens
- **Injection:** Depth/role override without in_chat position
- **Entry behavior:** Cooldown on constants, warmup unlikely to trigger, bootstrap with no keywords, probability zero, excluded from recursion with no keywords

**When to use:** Run after adding or modifying entries, or when entries aren't matching as expected. The health check catches misconfiguration that is easy to miss in a large vault.
