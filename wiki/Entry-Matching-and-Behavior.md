# Entry Matching & Behavior

Per-entry frontmatter fields and global settings that control when and how entries trigger. These features refine the basic keyword matching described in [[Pipeline]] — they give you fine-grained control over which entries activate under which conditions.

For the full frontmatter reference, see [[Writing Vault Entries]].

---

## Fuzzy Search (BM25)

When enabled, DLE supplements exact keyword matching with BM25-scored fuzzy search. This finds entries that are textually relevant to the conversation even when no exact keyword match occurs.

**How it works:**
1. During index building, DLE constructs a BM25 index from every entry's title, keys, and content
2. During matching, the scan text (recent chat messages) is tokenized and scored against the index
3. Entries that score above the minimum threshold (BM25 score >= 0.5) are added to the match set alongside keyword matches
4. Up to 20 fuzzy results are returned per generation, sorted by score

BM25 (Best Matching 25) is a term-frequency/inverse-document-frequency algorithm. It scores documents higher when they share many terms with the query, weighted by how rare those terms are across the whole vault. Common words contribute little; distinctive terms contribute a lot.

**What it catches that keywords miss:**
- Entries where the conversation uses synonyms or related terms instead of exact keywords
- Entries with long, descriptive content that overlaps thematically with the chat
- Entries where you forgot to add a keyword that the chat is using

**Setup:** Check "Enable Fuzzy Search" in [[Settings Reference|Matching & Budget settings]].

**Notes:**
- Fuzzy matches appear in the pipeline inspector and Context Cartographer with the label "(fuzzy, score: N.N)"
- Fuzzy results still respect cooldown, probability, and other per-entry behavior settings
- The BM25 index is rebuilt every time the vault index refreshes
- Works alongside keyword matching — it adds to the match set, never removes from it
- In two-stage mode, fuzzy matches are included in the candidate manifest sent to the AI

---

## Cooldown

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

## Warmup

Per-entry `warmup: N` in frontmatter. An entry's keywords must appear N or more times in the scan text before it triggers. This check runs every generation, not just the first time.

**Use case:** Prevent entries from triggering on a single casual mention. Ensure a topic is being discussed in depth before injecting detailed lore.

**Example:**
```yaml
warmup: 3  # Keyword must appear 3+ times in scan text each generation
```

**Notes:**
- The warmup threshold is checked every generation — the keyword must meet the hit count each time, not just the first time
- Count is based on occurrences in the scan text, not unique messages

---

## Re-injection Cooldown

Global setting (not per-entry). Skips re-injecting an entry for N generations after it was last injected. Helps save context by avoiding redundant lore repetition.

**Setup:** Set "Re-injection Cooldown" in [[Settings Reference|Matching & Budget settings]] (0 = disabled)

**Notes:**
- Constants (`#lorebook-always`) are exempt
- Tracked per-session (resets on chat change)
- Different from per-entry cooldown: re-injection cooldown is a global post-selection filter, while per-entry cooldown is checked during keyword matching

---

## Injection Deduplication

Global setting that prevents the same entries from being injected in consecutive generations. When enabled, entries that were injected within the last N generations (configurable lookback depth) are skipped.

**Setup:**
1. Check "Strip Duplicate Injections" in [[Settings Reference|Matching & Budget settings]]
2. Set the "Lookback Depth" (default 2 — checks last 2 generations)

**Notes:**
- Constants (`#lorebook-always`) are exempt — they always inject
- Injection history is tracked per-chat in `chat_metadata.deeplore_injection_log`
- Different from Re-injection Cooldown: deduplication checks a sliding window of recent generations, while re-injection cooldown counts generations since last injection

---

## Entry Decay & Freshness

Tracks how many generations have passed since each entry was last injected. Stale entries (not seen recently) get a boost in the AI manifest; frequently injected entries get a penalty. This naturally rotates lore without manual intervention.

**Setup:**
1. Enable "Entry Decay" in [[Settings Reference|Entry Decay settings]]
2. Set the **Boost Threshold** (default 5) — generations without injection before freshness boost
3. Set the **Penalty Threshold** (default 2) — consecutive injections before frequency penalty

**Notes:**
- Decay tracking is per-session (resets on chat change or page refresh)
- Only affects AI search manifest (adds decay hints for the AI to consider)
- Constants are exempt from decay penalties

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

## Active Character Boost

When enabled, automatically matches the active character's vault entry by name or keyword, even if the character isn't mentioned in recent chat messages.

**Use case:** Ensure the character you're roleplaying with always has their lore available, without relying on their name appearing in the most recent messages.

**Setup:** Check "Active Character Boost" in [[Settings Reference|Matching & Budget settings]]

---

## New Chat Bootstrapping

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
