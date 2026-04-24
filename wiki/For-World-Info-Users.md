# For World Info Users

If you already use SillyTavern's built-in **World Info** (WI) lorebook, most concepts transfer directly to DeepLore Enhanced (DLE) — but a few fields renamed, and two behave differently enough to bite you if you don't know. This page is the field-by-field cheat sheet.

**Core difference:** WI is a JSON file edited through ST's UI. DLE is a folder of Markdown notes in an [Obsidian](https://obsidian.md/) vault, indexed through the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. See [[Installation]] for the vault setup; this page assumes you already have a vault working.

---

## Field Mapping Cheat Sheet

| World Info field | DeepLore equivalent | Notes |
|---|---|---|
| `key` (primary keys) | `keys:` (YAML list) | One trigger keyword per list item. See [[Writing Vault Entries#Keys]]. |
| `keysecondary` (secondary keys) | `refine_keys:` | AND-ANY gating: entry activates only if at least one refine key is also present. |
| `comment` (entry name) | The note's filename / `# Title` | DLE uses the Obsidian note title as the entry title. |
| `content` | Everything below the frontmatter fence | Plain Markdown body. |
| `constant` (always inject) | Add the `lorebook-always` tag | See [[Glossary#Constant]]. |
| `order` | `priority:` | **Semantic flip — see warning below.** |
| `position` (before/after/AN top/AN bottom/at depth) | `position:` (`before` / `after` / `in_chat`) | DLE currently supports these three. ANTop/ANBottom/EMTop/EMBottom/atDepth are on the roadmap (BUG-051). |
| `depth` | `depth:` | Used when `position: in_chat`. |
| `role` | `role:` (`system` / `user` / `assistant`) | Used when `position: in_chat`. |
| `probability` | `probability:` | **Scale differs — see warning below.** |
| `scanDepth` (per-entry override) | `scanDepth:` | Chat messages to scan for this entry's keys. |
| `excludeRecursion` | `excludeRecursion:` | Skip this entry during recursive scans. |
| `disable` | `enabled: false` | Inverted sense — DLE's default is enabled. |
| `selectiveLogic` (AND_ALL / NOT_ALL / NOT_ANY) | **Not yet supported** (AND_ANY only) | Roadmap: BUG-046. |
| `sticky` (stay active N messages) | **Not yet supported** | Roadmap: BUG-047. Field preserved on import but not enforced. |
| `delay` / `delayUntilRecursion` | **Not yet supported** | Roadmap: BUG-048. |
| `group` / `useGroupScoring` / `group_weight` | **Not yet supported** | Roadmap: BUG-052. Fields preserved on import but not enforced. |
| `caseSensitive` / `matchWholeWords` (per-entry) | **Not yet supported** (global setting only) | Roadmap: BUG-096. |
| Regex key (`/pattern/flags`) | **Not yet supported** | Treated as literal string. Roadmap: BUG-045. |

---

## Two Gotchas That Bite

### 1. Priority is inverted

In **World Info**, a higher `order` number means the entry appears **first** in the injected block.

In **DeepLore**, a **lower** `priority` number means the entry is **more important** and wins budget/ordering decisions.

```
WI:  order: 100   →  shows up first
DLE: priority: 10 →  shows up first
```

The `/dle-import` tool keeps your numbers as-is, which means the **sort order flips**. Review priority on imported entries. See [[Writing Vault Entries#Priority]] for guidance on choosing values.

### 2. Probability is a fraction, not a percent

In **World Info**, `probability: 50` means "50% chance."

In **DeepLore**, `probability` is a **0.0–1.0** fraction — `probability: 0.5` means 50%.

An imported `probability: 50` evaluates as `50 > 1.0`, which always passes. No random gating. Convert to fractions manually after import. (Roadmap item BUG-099 will auto-rescale or reject out-of-range values.)

---

## DLE-Only Concepts (No WI Equivalent)

These are not in WI — skim once so you know they exist:

- **Seed Entries** (`lorebook-seed`) — content sent to the **AI search stage** as story context on new chats. Not injected into writing AI. See [[Glossary#Seed Entry]].
- **Bootstrap Entries** (`lorebook-bootstrap`) — force-inject when chat is short, then become regular triggered entries. See [[Glossary#Bootstrap Entry]].
- **Guide Entries** (`lorebook-guide`) — Librarian-only writing/style guide. Never reaches the writing AI. See [[AI-Powered Tools#Librarian]].
- **Summary field** — `summary:` tells the AI selector *when* to pick this entry. Required for AI search to work well. See [[Writing Vault Entries#Summary]].
- **Contextual gating** — `era`, `location`, `scene_type`, `character_present` and your own custom fields filter entries by story state. See [[Custom Fields]].
- **Requires / excludes** — entry title graph gating. `requires: [Bloodchain]` means "only inject me if Bloodchain was also selected." See [[Entry Matching and Behavior]].
- **Cooldown / warmup** — timing gates per entry. See [[Entry Matching and Behavior]].

---

## Importing Your World Info JSON

DLE ships an importer that converts WI JSON into Markdown notes with proper frontmatter.

**Steps:**
1. Export your WI book from SillyTavern (or copy the character card with embedded WI).
2. In chat, run `/dle-import`.
3. Paste the JSON (or select the book from the dropdown) and pick a target folder in your vault.
4. The importer creates one `.md` file per entry with frontmatter filled in.

**What converts cleanly:**
`key` → `keys`, `keysecondary` → `refine_keys`, `comment` → note title, `position` + `depth` + `role`, `scanDepth`, `excludeRecursion`, `constant` → `lorebook-always` tag.

**What needs your review after import:**
- `priority` (semantic flip — see above)
- `probability` (scale change — see above)
- `selectiveLogic` (not yet supported — any non-AND_ANY entries will misbehave)
- `sticky`, `delay`, `group*` (preserved on import, not yet enforced)

See [[Setup and Import#ST Lorebook Import Bridge]] for the full importer reference and [[Roadmap#WI Parity Gaps]] for the list of WI features still in flight.

---

## Running WI and DLE Side by Side

DLE does not disable SillyTavern's built-in World Info. If you have both active, DLE's entries are injected via the extension prompt channel and WI entries are injected via the standard WI channel — they co-exist but do not talk to each other.

**Recommended:** pick one. Either migrate fully to DLE, or keep using WI. Running both doubles your maintenance and can double-inject entries. The `/dle-import` bridge is built to make the full migration painless.
