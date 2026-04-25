# For World Info Users

If you already use SillyTavern's built-in World Info (WI) lorebook, most concepts transfer directly to DeepLore. A few fields renamed, two behave differently enough to bite you, and a handful of WI features aren't yet implemented. This page is the field-by-field cheat sheet.

**Core difference:** WI is a JSON file edited through ST's UI. DeepLore is a folder of Markdown notes in an [Obsidian](https://obsidian.md/) vault, indexed through the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. See [[Installation]] for vault setup; this page assumes you already have a vault working.

---

## Field mapping cheat sheet

| World Info field | DeepLore equivalent | Notes |
|---|---|---|
| `key` (primary keys) | `keys:` (YAML list) | One trigger keyword per list item. Comma-string format from older ST exports auto-splits on import. See [[Writing Vault Entries#Keys]]. |
| `keysecondary` (secondary keys) | `refine_keys:` | AND-ANY gating: entry activates only if at least one refine key is also present. |
| `comment` (entry name) | The note's filename and `# Title` | DeepLore uses the Obsidian note title as the entry title. Falls back to the first key if `comment` is empty. |
| `content` | Everything below the frontmatter fence | Plain Markdown body. |
| `constant` (always inject) | The `lorebook-always` tag | See [[Glossary#Constant]]. |
| `order` | `priority:` | **Semantic flip. See gotcha 1 below.** |
| `position` (5 ST positions) | `position:` (`before` / `after` / `in_chat`) | Lossy: ST has 5 values, DeepLore has 3. The original ST value is preserved as a YAML comment (`# original_st_position: N`) for round-tripping. |
| `depth` | `depth:` | Used when `position: in_chat`. |
| `role` | `role:` (`system` / `user` / `assistant`) | Supported in DeepLore frontmatter, but the importer drops the field. Re-add manually after import if you need it. |
| `probability` | `probability:` | Auto-rescaled on import (0-100 to 0.0-1.0). See gotcha 2 below for the manual-authoring footgun. |
| `scanDepth` (per-entry override) | `scanDepth:` | Chat messages to scan for this entry's keys. |
| `excludeRecursion` | `excludeRecursion:` | Supported in DeepLore frontmatter, but the importer drops the field. Re-add manually after import. |
| `disable` | `enabled: false` | Inverted sense; default is enabled. The importer drops the field, so disabled WI entries arrive enabled. |
| `selectiveLogic` (AND_ALL / NOT_ALL / NOT_ANY) | **Not yet supported** (AND_ANY only) | Roadmap: BUG-046. NOT_ANY books are silently inverted. |
| `sticky` (stay active N messages) | **Not yet supported** | Roadmap: BUG-047. Field preserved on import; not enforced. |
| `delay` / `delayUntilRecursion` | **Not yet supported** | Roadmap: BUG-048. Field preserved on import; not enforced. |
| `group` / `useGroupScoring` / `groupWeight` | **Not yet supported** | Roadmap: BUG-052. Fields preserved on import; not enforced. |
| `caseSensitive` / `matchWholeWords` (per-entry) | **Not yet supported** (global setting only) | Roadmap: BUG-096. |
| Regex key (`/pattern/flags`) | **Not yet supported** | Treated as literal string. Roadmap: BUG-045. |
| `preventRecursion` | **Not yet supported** | Roadmap: BUG-050. Only `excludeRecursion` exists. |

---

## Two gotchas that bite

### 1. Priority is inverted

In **World Info**, a higher `order` number means the entry appears **first** in the injected block.

In **DeepLore**, a **lower** `priority` number means the entry is **more important** and wins budget and ordering decisions.

```
WI:  order: 100   →  shows up first
DLE: priority: 10 →  shows up first
```

`/dle-import` keeps your numbers as-is, so the sort order flips after import. The importer fires a one-shot warning toast about this. Review and re-priority your imported entries. See [[Writing Vault Entries#Priority]] for guidance on choosing values.

### 2. Probability is a fraction in DeepLore

In **World Info**, `probability: 50` means "50% chance."

In **DeepLore**, `probability` is a 0.0 to 1.0 fraction. `probability: 0.5` means 50%.

`/dle-import` rescales the field automatically. Imported entries arrive with `probability: 0.50`. The footgun is **hand-authored** entries: if you write `probability: 50` in YAML directly, DeepLore evaluates `50 > 1.0` and the gate always passes (no random branch). Roadmap item BUG-099 will reject or rescale out-of-range values; until then, write fractions.

---

## DeepLore-only concepts (no WI equivalent)

These don't exist in WI. Skim once so you know they're there:

- **Seed entries** (`lorebook-seed`): content sent to the AI search stage as story context on new chats. Force-injected into the writing AI prompt as well. See [[Glossary#Seed Entry]].
- **Bootstrap entries** (`lorebook-bootstrap`): force-inject when chat is short (default: 3 or fewer messages), then become regular triggered entries. See [[Glossary#Bootstrap Entry]].
- **Guide entries** (`lorebook-guide`): Librarian-only writing and style guides. Never reach the writing AI through any path. See [[AI-Powered Tools#Librarian]].
- **`summary` field**: tells AI search *when* to pick this entry. Required for AI search to work well. See [[Writing Vault Entries#Summary]].
- **Contextual gating**: `era`, `location`, `scene_type`, `character_present`, plus your own custom fields filter entries by story state. See [[Custom Fields]].
- **`requires` / `excludes`**: entry-title graph gating. `requires: [Bloodchain]` means "only inject me if Bloodchain was also selected." See [[Entry Matching and Behavior]].
- **`cooldown` / `warmup`**: per-entry timing gates. See [[Entry Matching and Behavior]].
- **`outlet`**: macro-based injection via `{{outlet::name}}` instead of positional. See [[Injection and Context Control]].

---

## Importing your World Info JSON

DeepLore ships an importer that converts WI JSON into Markdown notes with proper frontmatter. Three input methods: the dropdown (lists existing ST lorebooks), a local file browser, or paste-text into the textarea.

**Steps:**

1. Export your WI book from SillyTavern (or copy the character card with embedded WI).
2. In chat, run `/dle-import [folder]`. A folder argument writes there; without one, entries land in the vault root.
3. In the popup: select the lorebook from the dropdown, browse a JSON file, or paste JSON text.
4. The importer creates one `.md` file per entry with frontmatter filled in. Duplicate filenames get a `_imported` suffix; nothing is silently overwritten.
5. After import, if AI search is enabled, the importer offers to generate AI summaries for each new entry (replacing the `"Imported from SillyTavern World Info"` placeholder).

**What converts cleanly:** `key`, `keysecondary`, `comment`, `position` plus `depth`, `scanDepth`, `constant`, `probability` (auto-rescaled), `sticky` / `delay` / `group` / `groupWeight` (preserved as YAML for round-trip).

**What needs manual review or re-add after import:**

- `priority` (semantic flip; the toast warns you)
- `role` (importer drops it; re-add for in-chat injections that need a specific role)
- `excludeRecursion` (importer drops it)
- `disable` (importer drops it; disabled WI entries arrive enabled)
- `selectiveLogic` (only AND_ANY works; NOT_ANY entries silently invert)
- `sticky`, `delay`, `group*` (preserved but not enforced)
- Regex keys (treated as literal strings)

See [[Setup and Import#ST lorebook import bridge]] for the full importer reference and [[Roadmap#Entry Matching & Gating]] plus the WI parity section of the Roadmap for the list of features still in flight.

---

## Running WI and DeepLore side by side

DeepLore does not disable SillyTavern's built-in World Info. With both active, DeepLore's entries inject via the extension prompt channel and WI entries inject via the standard WI channel. They co-exist; they don't talk to each other.

**Recommended:** pick one. Either migrate fully to DeepLore, or keep using WI. Running both doubles your maintenance and can double-inject entries. The `/dle-import` bridge is built to make the full migration painless.
