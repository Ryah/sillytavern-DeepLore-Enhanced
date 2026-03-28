# Pipeline

DeepLore Enhanced uses a sequential pipeline to determine which vault entries get injected into each generation. This page explains every stage.

## Pipeline Flow

```
init()
  └─ hydrateFromCache()               On first load: instant hydration from IndexedDB

onGenerate(chat)
  │
  ├─ Acquire generation lock           Prevents concurrent pipelines (90s stale timeout)
  ├─ Capture epoch guards              chatEpoch + generationLockEpoch for race detection
  │
  ├─ ensureIndexFresh()               Refresh from Obsidian if cache expired
  │    └─ buildIndexWithReuse()          Fetch all, skip re-parse of unchanged, fall back to full
  │
  ├─ runPipeline(chat)                Core matching pipeline
  │    ├─ matchEntries(chat)            Keyword scan (broad pre-filter)
  │    │    ├─ buildScanText(chat)        Concatenate recent messages
  │    │    ├─ keyword matching           Check each entry's keys against scan text
  │    │    ├─ BM25 fuzzy search          Supplement with TF-IDF scored matches (if enabled)
  │    │    ├─ per-entry scanDepth        Override scan depth for specific entries
  │    │    ├─ warmup/probability/        Per-entry behavior checks
  │    │    │  cooldown checks
  │    │    ├─ cascade links              Pull in unconditionally linked entries
  │    │    ├─ recursive scanning         Scan matched entry content for more triggers
  │    │    └─ Active Character Boost     Auto-match active character's entry
  │    │
  │    ├─ wikilink expansion            Add resolved-link targets as AI candidates
  │    ├─ contextual pre-gating         Gate entries before AI to avoid wasting selections
  │    ├─ hierarchicalPreFilter()      For 40+ entries: cluster by category, AI picks categories
  │    ├─ buildCandidateManifest()     Build compact manifest from candidates
  │    │
  │    └─ aiSearch(chat, manifest)     AI selects best from candidates
  │         ├─ throttle check            2s minimum between API calls
  │         ├─ circuit breaker check     Skip if AI circuit is open (2 failures, 30s cooldown)
  │         ├─ sliding window cache      Reuse if manifest unchanged + no new entity mentions
  │         ├─ build AI context          Recent chat + manifest + header (+ scribe summary)
  │         ├─ call AI (profile/proxy)   Send to configured AI connection
  │         ├─ parse response            Extract JSON array of selections
  │         └─ confidence-gated budget   Over-request 2x, sort by confidence tier
  │
  ├─ [epoch check]                     Bail if chat changed or pipeline superseded
  │
  ├─ Apply pin/block overrides        Per-chat pins force-inject, blocks remove
  ├─ Contextual gating                Filter by era/location/scene/character + custom fields
  ├─ Re-injection cooldown            Skip entries injected within N generations
  ├─ applyRequiresExcludesGating()    Apply requires/excludes rules (iterative cascade)
  ├─ Strip duplicate injections       Skip entries injected in recent generations
  │
  ├─ formatAndGroup(entries)          Budget limits + injection grouping
  │    ├─ sort by priority              Lower number = higher priority
  │    ├─ apply entry limit             Max entries cap (if not unlimited)
  │    ├─ apply token budget            Max tokens cap (if not unlimited)
  │    ├─ apply injection template      Format with {{title}} and {{content}}
  │    └─ group by injection position   Separate groups for before/after/in_chat
  │
  ├─ setExtensionPrompt()            Inject each group into SillyTavern context
  ├─ Author's Notebook injection       Inject per-chat notebook (if enabled)
  │
  └─ Post-processing
       ├─ trackGeneration()             Update cooldowns, warmup, decay trackers
       ├─ Record injection dedup log    Track what was injected for strip-dedup
       ├─ Per-chat injection counts     Increment per-entry counts (swipe-aware undo)
       ├─ recordAnalytics()             Persist match/injection stats (batched every 5 gens)
       └─ Context usage warning         Warn if lore exceeds 20% of context window
```

## Three Pipeline Modes

### Two-Stage (keywords → AI)
The default and recommended mode. Keywords run first to narrow down candidates, then the AI picks the best from those candidates.

```
Keywords match 20 entries  →  AI selects 8 most relevant  →  Inject 8 + constants
```

**Error fallback:** Configurable via the AI Error Fallback setting (default: fall back to keyword results). Options: keyword results, constants only, constants + bootstrap, or nothing.
**Empty fallback:** Configurable via the AI Empty Result Fallback setting (default: constants only). Options: constants, constants + bootstrap, keyword results, or nothing.

### AI Only (full vault)
Skips keyword matching entirely. The entire vault manifest is sent to the AI.

```
Full vault (100 entries)  →  AI selects 10 most relevant  →  Inject 10 + constants
```

More thorough but uses more tokens per call. Best for vaults where keywords are sparse or unreliable.

**Error fallback:** Same configurable options as Two-Stage mode.
**Empty fallback:** Same configurable options as Two-Stage mode.

### Keywords Only (AI disabled)
When AI Search is disabled. Pure keyword matching.

```
Keywords match 12 entries  →  Inject 12 + constants
```

No API calls, no latency. Good for simple setups or when you want full control via keywords.

## Stage Details

### Generation Lock
The pipeline acquires an exclusive lock before starting. Only one pipeline can run at a time. The lock has a 90-second stale timeout — if a previous pipeline crashed or hung, the lock auto-releases so the next generation isn't blocked forever. The lock is epoch-tagged: if a new generation force-acquires a stale lock, the old pipeline detects it and bails.

### Epoch Guards
Two epoch counters prevent race conditions:
- **chatEpoch**: Increments when the user switches chats. If the epoch changes mid-pipeline, results are discarded (they belong to the wrong chat).
- **generationLockEpoch**: Increments when the lock is acquired (including force-releases). If a newer pipeline takes over, the old one detects it and stops.

### IndexedDB Hydration
On first page load, the extension attempts to load the vault index from IndexedDB (browser-side persistent cache). If found, the index is available immediately — no Obsidian call needed. A background validation against Obsidian runs to ensure the cache is still fresh.

### Index Refresh
Before matching, the pipeline checks if the cached vault index is stale (based on Cache TTL, or generation count if using generation-based rebuild). If expired, it first tries **reuse sync** (fetch all files, but skip re-parsing/tokenizing entries whose content hash is unchanged). If reuse sync fails, it falls back to a full rebuild of all `#lorebook` entries from Obsidian's Local REST API. The Obsidian connection uses a **per-vault circuit breaker** (closed/open/half-open with 2s-15s exponential backoff, keyed by host:port) to avoid hammering a down server. After a successful build, the index is saved to IndexedDB.

### Keyword Matching
1. **Build scan text**: Concatenate the last N messages (Scan Depth setting, default 4)
2. **Check each entry's keys**: For each entry with `keys`, test if any keyword appears in the scan text
   - Respects Case Sensitive and Match Whole Words settings
   - Entries with per-entry `scanDepth` use their own message window
   - If `refine_keys` is set, at least one refine key must also match (AND filter)
3. **Warmup check**: If entry has `warmup: N`, count keyword occurrences; skip if below threshold
4. **Probability check**: If entry has `probability: N` (0.0-1.0), roll a random number; skip if roll exceeds probability
5. **Cooldown check**: If entry has per-entry `cooldown` and is in cooldown, skip it
6. **Cascade links**: If matched entries have `cascade_links`, the listed entries are unconditionally pulled in (no keyword check)
7. **Recursive scanning**: If enabled, scan matched entries' content for keywords that trigger more entries. Repeats up to Max Recursion Steps. Entries with `excludeRecursion: true` are skipped.
8. **BM25 fuzzy search**: If Fuzzy Search is enabled, supplement keyword matches with BM25/TF-IDF scored results. Entries scoring above the Fuzzy Min Score threshold are added to the match set. Respects the same cooldown and probability gates as exact matches.
9. **Active Character Boost**: If enabled, auto-match the active character's entry by name/keyword even if not mentioned in chat
10. **Constants**: Entries tagged `#lorebook-always` or with `constant: true` are always included regardless of keywords
11. **Bootstrap**: If chat is below New Chat Threshold, `#lorebook-bootstrap` entries are force-included

### Hierarchical Pre-Filter
For large vaults (40+ selectable entries with 4+ distinct categories), the pipeline uses a two-call AI approach before regular AI search:
1. Group entries by category (from tags/type fields)
2. First AI call selects relevant categories
3. Only entries in selected categories proceed to the main AI search
Safety valve: if filtering removes more than 80% of entries, the pre-filter is skipped.

### AI Search
See [[AI Search]] for full details. In brief:
1. Build a compact manifest from keyword-matched candidates (or full vault in AI-only mode)
2. Check the **sliding window cache** — reuses results if manifest unchanged and new chat messages don't mention vault entities
3. Send manifest + recent chat to the AI (with Scribe summary if scribe-informed retrieval is enabled)
4. AI returns a JSON array of selected entries with confidence and reasons
5. **Confidence-gated budget**: AI over-requests (2x max entries), results sorted by confidence tier (high → medium → low) before budget cap
6. Selections replace keyword results (not merged)

### Pin/Block Overrides
After the main pipeline, per-chat pins and blocks are applied:
- **Pinned entries** are force-injected like constants (from `chat_metadata.deeplore_pins`)
- **Blocked entries** are removed regardless of matches (from `chat_metadata.deeplore_blocks`)

### Contextual Gating
Entries with gating frontmatter fields (`era`, `location`, `scene_type`, `character_present`, or any user-defined custom field) are filtered against the active context state (stored in `chat_metadata.deeplore_context`). Custom gating fields are defined in `DeepLore/field-definitions.yaml` and support configurable types and operators. Entries without contextual fields pass through unaffected.

### Gating
After selection, entries with `requires` and `excludes` fields are evaluated:
- **requires:** ALL listed entry titles must be in the matched set, or this entry is removed
- **excludes:** If ANY listed entry title is in the matched set, this entry is removed
- Resolution is **iterative**. Removing one entry can cascade to remove others that require it.

### Re-injection Cooldown
If the global Re-injection Cooldown setting is non-zero, entries that were injected within the last N generations are skipped. This is different from per-entry `cooldown` (which is checked during keyword matching) — re-injection cooldown is a global post-selection filter. Constants are exempt.

### Injection Deduplication
If "Strip Duplicate Injections" is enabled, entries that were injected in recent generations (within the lookback depth) are stripped before formatting. Constants are exempt. Injection history is tracked per-chat in `chat_metadata.deeplore_injection_log`.

### Budget & Formatting
1. Sort remaining entries by priority (lower number first)
2. Apply Max Entries cap (if Unlimited Entries is off)
3. Apply Token Budget cap (if Unlimited Token Budget is off). Entries are added in priority order until budget is reached. If an entry partially fits, it is truncated to the nearest sentence boundary. If the highest-priority entry exceeds the entire budget and cannot be meaningfully truncated, it is skipped with a debug warning.
4. Format each entry using the Injection Template (`{{title}}` and `{{content}}` macros)
5. Group entries by their effective injection position (global default or per-entry override)

### Injection
Each group is injected separately into SillyTavern via `setExtensionPrompt()`:
- **Before Main Prompt**: Injected before the system prompt / story string
- **After Main Prompt**: Injected after the system prompt / story string
- **In-chat**: Injected as a message at the specified depth and role

If **Allow World Info Scan** is enabled, SillyTavern's built-in World Info system can scan the injected lore for additional WI keyword matches.

### Author's Notebook
After lorebook entries are injected, the Author's Notebook is injected separately (if enabled). The notebook has its own injection position, depth, and role settings. It is independent of the lorebook pipeline — it always injects when enabled, regardless of entry matching.

### Post-Processing
After injection, the pipeline updates internal state:
- **Track generation**: Update per-entry cooldown timers, warmup counters, and decay trackers (staleness/frequency)
- **Injection dedup log**: Record which entries were injected for the Strip Duplicate Injections feature
- **Per-chat injection counts**: Increment each injected entry's per-chat count. If a **swipe** is detected (chat length unchanged from last generation), the previous round's counts are undone first — only the final accepted response's injections count.
- **Analytics**: Persist match/injection statistics to settings. To reduce disk I/O, analytics are only written to persistent storage every 5 generations. Stale analytics entries (>30 days) are pruned automatically.
- **Context usage warning**: If injected lore exceeds 20% of the context window, a warning toast appears. The warning throttles to avoid spam — it only re-fires when the ratio increases by more than 5%.

## Inspecting the Pipeline

Use the `/dle-inspect` slash command to see a detailed trace of the last generation:
- Which entries matched by keywords (and which keywords triggered them)
- Which entries were selected by AI (with confidence and reasons)
- Which entries were injected (with token counts and truncation markers)
- Which entries were gated out by requires/excludes rules (with reasons)
- Which entries were removed by contextual gating, cooldown, strip-dedup, probability, or warmup
- Which entries were cut by budget/max-entries limits
- Whether AI fallback was used, and the pipeline mode that was active

The trace is also available as a copyable plain-text block. See [[Slash Commands]] for more details.
