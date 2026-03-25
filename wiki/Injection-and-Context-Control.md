# Injection & Context Control

How and where entries are injected into the prompt, and per-chat overrides for controlling what gets injected.

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

## Prompt Manager Integration

Set **Injection Mode** to **Prompt List** to register DLE's injections as named entries in SillyTavern's Prompt Manager. This lets you drag them to any position in the prompt order — before character definition, after Author's Note, between example messages, wherever.

**How it works:**
1. Switch injection mode to "Prompt List" in DLE settings
2. Generate at least once so the entries appear
3. Open the Prompt Manager and find `deeplore_constants` and `deeplore_lore`
4. Drag them to your desired position, or switch to Absolute mode with a custom depth

**Notes:**
- Requires a Chat Completion API (OpenAI-compatible)
- Per-entry frontmatter overrides with custom position/depth still create separate injection groups
- The `deeplore_notebook` entry also appears in the PM (it already uses a stable key)

---

## Author's Notebook

A persistent per-chat scratchpad that is injected into every generation. Use it for author notes, scene direction, tone guidance, or anything you want the writing AI to always see for this specific chat.

**How it works:**
1. Open the notebook via `/dle-notebook` or the "Open Notebook" button in settings
2. Write any text — it's saved per-chat in `chat_metadata`
3. The notebook content is injected into every generation as a separate prompt, independent of the entry pipeline

**Setup:**
1. Enable "Enable Author's Notebook" in [[Settings Reference|Author's Notebook settings]]
2. Choose injection position (Before Main Prompt, After Main Prompt, or In-chat @ Depth)
3. Open the editor and start writing

**Notes:**
- Notebook content is stored in `chat_metadata.deeplore_notebook` — it persists across sessions for that chat
- Injection is independent of the lorebook pipeline — the notebook always injects when enabled, regardless of matching
- Has its own position, depth, and role settings separate from the main lorebook injection

---

## Per-Chat Pin/Block

Pin entries to always inject or block entries from injecting, on a per-chat basis. Pins and blocks are stored in `chat_metadata` and survive page reloads.

**Commands:**
- `/dle-pin <entry name>` — Pin an entry (always inject in this chat)
- `/dle-unpin <entry name>` — Remove a pin
- `/dle-block <entry name>` — Block an entry (never inject in this chat)
- `/dle-unblock <entry name>` — Remove a block
- `/dle-pins` — Show all pins and blocks for the current chat

**How it works:**
- Pinned entries are force-injected like constants, regardless of keywords or AI selection
- Blocked entries are removed from the pipeline before injection, regardless of matches
- Pins/blocks apply after the main pipeline runs but before formatting

**UI access:** The [[Drawer]] Browse tab has inline pin/block buttons on each entry — no slash commands needed. Per-chat injection counts are displayed as badges on each entry.

---

## Contextual Gating

Filter entries based on the current story context using frontmatter fields: `era`, `location`, `scene_type`, and `character_present`. Set the active context with slash commands or the [[Drawer]] Gating tab, and entries that don't match the current context are filtered out.

**Frontmatter fields:**
| Field | Type | Description |
|-------|------|-------------|
| `era` | string | Entry only injects when the active era matches |
| `location` | string | Entry only injects when the active location matches |
| `scene_type` | string | Entry only injects when the active scene type matches |
| `character_present` | string[] | Entry only injects when any listed character is present |

**Commands:**
- `/dle-set-era [era]` — Set the active era. With no argument, opens a browse-and-select popup showing all era values in your vault with entry counts
- `/dle-set-location [location]` — Set the active location. With no argument, shows a browse-and-select popup
- `/dle-set-scene [type]` — Set the active scene type. With no argument, shows a browse-and-select popup
- `/dle-set-characters <names>` — Set present characters (comma-separated)
- `/dle-context-state` — Show the current contextual gating state

**Notes:**
- Context state is stored per-chat in `chat_metadata.deeplore_context`
- Entries without contextual fields are unaffected (always pass through)
- Partial matches work: an entry with only `era` set is filtered only on era, regardless of location/scene/character

---

## Confidence-Gated Budget

AI search over-requests entries (2x the configured max), then sorts results by confidence tier (high, medium, low) before applying the budget cap. High-confidence picks are prioritized, ensuring that when budget is limited, the most relevant entries make the cut.

**How it works:**
1. The AI is asked to select up to 2x your maxEntries setting
2. Results are sorted: high confidence first, then medium, then low
3. The budget and max entries caps are applied to this sorted list
4. Low-confidence picks are the first to be cut when budget is tight

This means the AI has room to suggest marginal entries without displacing clearly relevant ones.
