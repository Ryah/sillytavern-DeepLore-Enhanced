# Writing Vault Entries

This page explains how to create lorebook entries in your Obsidian vault for DeepLore. Every template below is a complete, working example you can copy into a new Obsidian note and modify.

## How it works

1. You write notes in Obsidian with YAML frontmatter
2. Notes tagged with `#lorebook` are indexed as lorebook entries
3. The `keys` field lists keywords. When those keywords appear in recent chat messages, the entry is injected into the AI prompt
4. With [[AI Search]] enabled, a `summary` field helps the AI decide when to select the entry even without exact keyword matches

That's it. Tag it, give it keywords, write your lore.

## Frontmatter fields reference

Every entry needs YAML frontmatter between `---` fences at the top of the file. Only `tags` (with `lorebook`) is strictly required, but you'll almost always want `keys` too.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tags` | array | *(required)* | Must include `lorebook`. Can also include special tags (see below). |
| `keys` | array | `[]` | Keywords that trigger this entry when they appear in chat. |
| `priority` | number | `100` | Sort order. Lower numbers are injected first. See [priority guidelines](#priority-guidelines). |
| `summary` | string | `""` | AI selection summary (recommended under 600 chars). Used by [[AI Search]] to decide relevance. **Not injected into the writing AI.** |
| `requires` | array | `[]` | Entry titles that must ALL be matched for this entry to activate. |
| `excludes` | array | `[]` | Entry titles that, if ANY are matched, block this entry. |
| `position` | string | *(global setting)* | Override injection position: `before`, `after`, or `in_chat`. |
| `depth` | number | *(global setting)* | Override injection depth (for `in_chat` position). Clamped to 0-10000. |
| `role` | string | *(global setting)* | Override injection role: `system`, `user`, or `assistant`. |
| `scanDepth` | number | *(global setting)* | Override how many recent messages to scan for this entry's keywords. |
| `excludeRecursion` | boolean | `false` | If `true`, this entry is skipped during recursive link scanning. |
| `constant` | boolean | `false` | If `true`, this entry is always injected regardless of keywords or AI. Equivalent to the `#lorebook-always` tag. |
| `refine_keys` | array | `[]` | Secondary keywords. If set, at least one refine key must **also** match (alongside a primary `keys` match) for the entry to trigger. Acts as an AND filter to reduce false positives. |
| `cascade_links` | array | `[]` | Entry titles to automatically pull in when this entry matches. Unlike wikilink recursion, cascade links are pulled unconditionally (no keyword check needed). |
| `cooldown` | number | *(none)* | After triggering, skip this entry for N generations. |
| `warmup` | number | *(none)* | Require the keyword to appear N or more times in the scan text before triggering. |
| `probability` | number | *(none)* | Chance of triggering when matched (0.0-1.0). Omit or set to 1.0 for always trigger. |
| `enabled` | boolean | `true` | Set to `false` to skip this entry entirely during indexing. The entry won't appear in the vault index at all. Useful for temporarily disabling an entry without removing the `#lorebook` tag. |
| `outlet` | string | *(none)* | Macro-based injection: when set, the entry is injected wherever you place the `{{outlet::name}}` macro instead of using positional injection. |
| `era` | string \| string[] | *(none)* | Contextual gating (default custom field): only inject when the active era matches one of these values. See [[Custom Fields]]. |
| `location` | string \| string[] | *(none)* | Contextual gating (default custom field): only inject when the active location matches one of these values. |
| `scene_type` | string \| string[] | *(none)* | Contextual gating (default custom field): only inject when the active scene type matches one of these values. |
| `character_present` | array | `[]` | Contextual gating (default custom field): only inject when any listed character is among the present characters. |
| *(custom fields)* | varies | *(none)* | You can define additional custom gating fields beyond the four defaults. Field definitions are stored in `DeepLore/field-definitions.yaml` in your vault and managed via the "Manage Fields" rule builder. See [[Custom Fields]]. |
| `graph` | boolean | `true` | Set to `false` to exclude this entry from the relationship graph. The entry still works normally for matching and injection. Useful for test entries, meta entries, or entries that add noise to the graph without meaningful connections. |

> [!NOTE]
> Frontmatter uses underscores (`scene_type`, `character_present`), but internally these are stored as camelCase (`sceneType`, `characterPresent`) on VaultEntry objects. Use underscores in your notes.

### Priority guidelines

| Range | Use For | Examples |
|-------|---------|---------|
| 10-20 | Inner circle, critical context | Main character, core world rules |
| 30-40 | Core lore, major characters | Important NPCs, key locations |
| 50 | Standard entries | Most entries |
| 60-70 | Secondary, flavor | Minor characters, background details |
| 80-100 | Low priority, rare | Obscure trivia, edge cases |

### Special tags

Add these alongside `#lorebook` to change how an entry behaves:

| Tag | Behavior |
|-----|----------|
| `#lorebook` | Marks this note as a lorebook entry (required). |
| `#lorebook-always` | **Constant.** Always injected regardless of keywords or AI. |
| `#lorebook-never` | **Excluded.** Never injected, even if keywords match. |
| `#lorebook-seed` | **Seed.** Content is sent to the AI search model as story context on new chats. Not injected into the writing AI. |
| `#lorebook-bootstrap` | **Bootstrap.** Force-injected when the chat is short (at or below the new chat threshold, default 3 messages), then becomes a regular keyword entry. |
| `#lorebook-guide` | **Guide.** Librarian-only writing/style reference. Emma fetches via `get_writing_guide`. Never reaches the writing AI through any path. |

Tags are configurable in [[Settings Reference]]. The defaults above assume you haven't changed them.

> [!IMPORTANT]
> If an entry has both `#lorebook-guide` and any of `#lorebook-seed` / `#lorebook-bootstrap` / `#lorebook`, the `guide` flag wins at runtime: the entry stays Librarian-only.

## Content structure

After the frontmatter, write your entry content in regular Markdown. The recommended structure is:

```
# Entry Title

One-paragraph introduction -- what this is, in narrative prose.

<div class="meta-block">
[Field1: value | Field2: value | ...]
</div>

Remaining prose with full lore content.
Use [[wikilinks]] to cross-reference other entries.
```

The `<div class="meta-block">` is optional but recommended. It provides a compact, structured summary of key facts that the AI can parse quickly. The fields inside depend on the entry type (see templates below).

Use `[[wikilinks]]` to reference other entries in your vault. DeepLore uses these links for recursive scanning. If entry A is matched and links to entry B, entry B becomes a candidate too.

## Writing good summaries

The `summary` field is used **only** by [[AI Search]] to decide whether to select an entry. It is never injected into the writing AI's context (the full content handles that).

A good summary answers three questions:
1. **What is this?** Category, role, core identity (1 sentence)
2. **When should it be selected?** Situations, triggers, relevant topics (1-2 sentences)
3. **Key relationships.** Connected entries, if important (brief)

**Bad summary** (describes appearance, useless for selection):
> "Kael is tall with silver hair and violet eyes. He commands the shadows with an iron will and speaks in a low, measured tone."

**Good summary** (tells the AI *when* to pick this entry):
> "The protagonist's spymaster, interrogator, and closest enforcer. Inner circle. Select when espionage, intelligence gathering, interrogation, loyalty, or the Triumvirate betrayal comes up. Also relevant for surveillance, covert networks, and territory enforcement."

**Good summary** (lore concept):
> "The biological dependency created when a vampire feeds from a mortal. Select when feeding, biting, addiction, venom, feeding sites, or chattel dynamics come up. Scales with vampire age."

Keep summaries under 600 characters (recommended, not enforced; configurable via `aiSearchManifestSummaryLength`). Focus on *when to select*, not *what to write*.

---

## What each AI sees

Your vault entry is used by two different AIs that see very different things. Understanding the difference helps you write better entries and summaries.

### The selection AI (AI Search manifest)

The selection AI **never sees your full entry**. It sees a compact one-line manifest entry and uses it to decide whether your entry is relevant to the current conversation:

```xml
<entry name="Valen Ashwick">
Valen Ashwick (285tok) → Ashwick Estate, Ironveil Guild, Sera Thornwick, Korrath
Rogue spellsword and former member of the Ironveil Guild. Select when melee combat,
dual-wielding, shadow magic, guild politics, or the Ashwick bloodline comes up.
Close ally of Sera and rival of Korrath.
</entry>
```

| Part | Source | Purpose |
|------|--------|---------|
| `Valen Ashwick` | Entry title | Identifies the entry |
| `(285tok)` | Estimated from content length | Helps the AI consider token budget |
| `→ Ashwick Estate, ...` | Extracted from `[[wikilinks]]` in content | Shows relationships to other entries |
| Summary text | `summary` frontmatter field | Tells the AI *when* to select this entry |

If an entry has no `summary` field, the content is truncated to ~600 characters instead. Writing good summaries matters: the selection AI's only context for your entry is this compact view.

An entry without a summary or wikilinks gets an even simpler manifest line:

```xml
<entry name="Silver Keep">
Silver Keep (25tok)
A crumbling fortress on the northern ridge, now home to bandits and bad memories.
</entry>
```

### The writing AI (injected context)

When an entry is selected, the writing AI sees your **cleaned content** wrapped in the injection template (default: `<Title>content</Title>`). Several things are automatically stripped before injection:

```xml
<Valen Ashwick>
A disgraced spellsword who left the Ironveil Guild after discovering their
true purpose. Now works as a mercenary, haunted by the magic branded into
his blood.

[Species: Half-elf | Role: Spellsword, mercenary | Aliases: the Duskblade | ...]

## Background
Valen grew up on the Ashwick Estate, trained from childhood in both blade
and spell...

## Relationships
- Sera Thornwick -- Closest ally...
- Korrath -- Former Guild partner turned hunter...

## Combat Style
Valen fights with twin short swords and weaves shadow magic between strikes...
</Valen Ashwick>
```

Notice what changed compared to the raw Obsidian note:
- The **first H1 heading** (`# Valen Ashwick`) is stripped. It's redundant with the XML wrapper title.
- **Wikilinks** are converted to plain text: `[[Sera Thornwick]]` becomes `Sera Thornwick`, `[[Link|Display]]` becomes `Display`.
- **HTML div tags** are stripped (the content inside is kept, so meta-blocks still work).
- **Image embeds** (`![[image.png]]`, `![alt](url)`) are removed.
- **Obsidian comments** (`%%...%%`) are removed.

| What's included | What's NOT included |
|-----------------|---------------------|
| Everything after the frontmatter `---` | YAML frontmatter (`keys`, `priority`, `summary`, `requires`, etc.) |
| Full prose, meta-blocks, all headings except H1 | The first H1 heading (used as title in the XML wrapper) |
| Wikilink text (converted to plain text) | Wikilink brackets and image embeds |
| Content outside exclusion zones | `%%deeplore-exclude%%` regions (see below) |

### Hiding content from the writing AI

You can put information in your vault entries that **never reaches the writing AI**. Useful for author notes, organizational metadata, or reference material you want in Obsidian but not in the prompt.

**Obsidian comments (`%%...%%`):** Anything between double-percent markers is stripped. Obsidian also hides these in reading mode, so they work as true hidden comments.

```markdown
## Background

Valen grew up on the Ashwick Estate, trained from childhood.

%%
Author note: This backstory contradicts the timeline in Chapter 3.
Need to reconcile before the next arc.
%%

He joined the Ironveil Guild at 19.
```

**Exclusion zones (`%%deeplore-exclude%%...%%/deeplore-exclude%%`):** For larger blocks you want visible in Obsidian's edit mode but hidden from the writing AI. These are stripped before any other processing.

```markdown
## Relationships

- **Sera Thornwick** -- Closest ally. She helped him escape the Guild.

%%deeplore-exclude%%
### Relationship Tracker (OOC)
- Sera: Trust 8/10, growing romantic tension
- Korrath: Nemesis, but conflicted
- Guild: Active hostility
%%/deeplore-exclude%%

- **Korrath** -- Former Guild partner turned hunter.
```

Both methods are also invisible to the selection AI's manifest (summaries and content truncation happen after cleaning).

The `summary` is for the selection AI. The content is for the writing AI. Two purposes, two surfaces. Write each accordingly.

---

## Templates

Every template below is a complete Obsidian note. Copy it into a new file, change the values, and you're done.

---

### 1. Minimum viable entry

The simplest possible entry: a tag, a keyword, and some content.

```markdown
---
tags:
  - lorebook
keys:
  - Silver Keep
---

# Silver Keep

A crumbling fortress on the northern ridge, now home to bandits and bad memories.
```

That's a valid entry. When "Silver Keep" appears in chat, this content gets injected.

---

### 2. Character

A full character entry with all commonly used fields.

```markdown
---
# -- Required --
tags:
  - lorebook
keys:
  - Valen
  - Valen Ashwick
  - the Duskblade

# -- Recommended --
priority: 35
summary: "Rogue spellsword and former member of the Ironveil Guild. Select when melee combat, dual-wielding, shadow magic, guild politics, or the Ashwick bloodline comes up. Close ally of Sera and rival of Korrath."

# -- Optional --
requires: []
excludes: []
---

# Valen Ashwick

A disgraced spellsword who left the [[Ironveil Guild]] after discovering their true purpose. Now works as a mercenary, haunted by the magic branded into his blood.

<div class="meta-block">
[Species: Half-elf | Role: Spellsword, mercenary | Aliases: the Duskblade | Height: 6'1" | Build: Lean, athletic | Hair: Black, shoulder-length | Eyes: Amber with faint glow | Skin: Olive, scarred forearms | Features: Guild brand on left wrist (burned but visible) | Apparent Age: Late 20s | True Age: 34 | Origin: Ashwick Estate, Greymarch | Personality: Guarded, sardonic, fiercely loyal once earned | Speech: Clipped, dry humor, avoids titles | Wants: Clear his family name | Fears: Becoming what the Guild made him | Powers: Shadow-step (short-range teleport), blade enhancement | Limits: Shadow magic drains stamina rapidly, useless in bright light | Items: Twin short swords (Dusk and Dawn), enchanted leather coat | Secret: The Guild brand slowly turns its bearers into living weapons]
</div>

## Background

Valen grew up on the [[Ashwick Estate]], trained from childhood in both blade and spell. He joined the [[Ironveil Guild]] at 19, believing them to be an elite mercenary company. He discovered they were binding members' souls to fuel a collective weapon -- the brand on his wrist is the first stage.

He deserted five years ago. The Guild wants him back, dead or alive.

## Relationships

- **[[Sera Thornwick]]** -- Closest ally. She helped him escape the Guild. He trusts her completely.
- **[[Korrath]]** -- Former Guild partner turned hunter. Korrath took the brand willingly and considers Valen a traitor.
- **[[Ironveil Guild]]** -- His former organization. They send hunters after him periodically.

## Combat Style

Valen fights with twin short swords and weaves shadow magic between strikes. He can shadow-step behind opponents but each use costs significant stamina. In prolonged fights, he relies increasingly on pure swordwork.
```

---

### 3. Location

A tavern, dungeon, city, or any place.

```markdown
---
tags:
  - lorebook
keys:
  - The Drowned Lantern
  - Drowned Lantern
  - the tavern

priority: 50
summary: "Underground tavern in the Docks district, neutral ground for criminals and adventurers. Select when characters are drinking, meeting contacts, gathering rumors, or visiting the Docks. Owned by Maren Blacktide."
---

# The Drowned Lantern

A half-sunken tavern built into the old sea wall of the Docks district. The lower floor floods at high tide, which the regulars consider a feature, not a bug.

<div class="meta-block">
[Category: Tavern | Owner: [[Maren Blacktide]] | District: The Docks | Access: Public, but newcomers get watched | Atmosphere: Smoky, damp, lantern-lit, loud at night | Function: Neutral meeting ground, black market contacts | Layout: Upper bar (dry), lower bar (floods at high tide), back rooms for private deals | Rules: No killing inside, disputes settled by Maren | Security: Two bouncers, Maren herself, and a rumored sea creature in the flooded basement | Regulars: Smugglers, off-duty guards, bounty hunters, [[Valen Ashwick]]]
</div>

## Description

The entrance is a rusted iron door set into the sea wall, marked only by a lantern wrapped in green glass. Steps lead down into a long, vaulted room that smells of brine and pipe smoke. The upper bar sits on a stone platform; the lower bar is three steps down and ankle-deep in seawater during high tide.

Maren keeps the peace with an iron voice and the threat of whatever lives beneath the floorboards. Fights happen outside or not at all.

## Notable Features

- **The Tide Table** -- A large round table on the lower level, partially submerged. Sitting there is a signal that you're open for business.
- **Back rooms** -- Three private rooms behind the bar. Maren charges by the hour and doesn't ask questions.
- **The basement** -- Flooded, locked, off-limits. Something moves down there. Maren feeds it.
```

---

### 4. Lore / world-building concept

For magic systems, political structures, historical events, or any world-building concept.

```markdown
---
tags:
  - lorebook
keys:
  - soulbrand
  - soul brand
  - branded
  - Guild brand

priority: 35
summary: "Magical branding ritual used by the Ironveil Guild to bind members' souls into a collective weapon. Select when the Guild, magical binding, soul magic, Valen's brand, or forced servitude comes up. Core lore for Guild-related plotlines."
---

# The Soulbrand

A ritual binding developed by the [[Ironveil Guild]] that permanently links a person's soul to the Guild's collective power. The brand manifests as a black sigil on the wrist that pulses faintly in the presence of other branded members.

<div class="meta-block">
[Category: Ritual magic | Scope: Ironveil Guild members only | Danger: Lethal if removed improperly, progressive loss of autonomy | Who Knows: Guild leadership, branded members (partially), [[Valen Ashwick]] (fully) | Triggers: Proximity to other branded, extreme emotion, Guild commands | Consequences: Gradual erosion of free will at advanced stages, eventual transformation into a living weapon | Related: [[Ironveil Guild]], [[Valen Ashwick]], [[Korrath]] | Enforcement: Guild hunters track and reclaim deserters | Misconceptions: New recruits believe it's a loyalty tattoo and standard Guild tradition]
</div>

## How It Works

The brand is applied during an initiation ritual disguised as a loyalty oath. The recruit feels a burning pain and gains a faint sense of other branded members -- presented as "Guild bond." In reality, the brand siphons a small amount of soul energy continuously.

**Stage 1 (Years 1-3):** Awareness of other branded. Minor combat enhancement. No obvious downsides.
**Stage 2 (Years 3-7):** Compulsion to obey senior branded. Difficulty acting against Guild interests. Enhanced reflexes.
**Stage 3 (Years 7+):** Near-total obedience. Significant combat power. The branded becomes a weapon the Guild can activate remotely.

## Removal

No safe removal method is known. [[Valen Ashwick]] burned his brand with alchemical fire, which stopped the progression but left the sigil scarred into his skin. He still feels the pull of other branded at close range.
```

---

### 5. Organization

A guild, faction, council, or any organized group.

```markdown
---
tags:
  - lorebook
keys:
  - Ironveil Guild
  - the Guild
  - Ironveil

priority: 40
summary: "Elite mercenary company that secretly binds members' souls via the Soulbrand ritual. Select when mercenary contracts, guild politics, soul magic, Valen's past, or organized military forces come up. Antagonist faction."
---

# The Ironveil Guild

A prestigious mercenary company operating across the northern territories. Publicly, they're known for discipline, reliability, and high rates. Privately, they are building an army of soul-bound soldiers.

<div class="meta-block">
[Category: Mercenary company / secret military order | Owner: The Iron Council (three unknown figures) | Run By: Guildmaster [[Torven Kael]] | Public Face: Elite mercenaries for hire | True Purpose: Building a soul-bound army via the [[Soulbrand]] | Visibility: Well-known publicly, true purpose hidden | Scope: Northern territories, expanding south | Staff: ~200 active members, ~40 fully branded | Key People: [[Torven Kael]] (Guildmaster), [[Korrath]] (Chief Hunter), [[Valen Ashwick]] (deserter) | Value: Military contracts, political influence, growing soul-bound force | Vulnerabilities: Deserters who know the truth, the Soulbrand's instability at Stage 3]
</div>

## Structure

The Guild operates from a fortress called the Iron Bastion. Recruits train for six months before initiation (when the [[Soulbrand]] is applied). They're organized into cells of four, each led by a branded senior. The cells take contracts independently but answer to the Guildmaster.

## Public Reputation

The Guild is respected. They complete contracts reliably, don't betray employers, and keep collateral damage low. Most people consider a Guild contract expensive but worth it. No one outside suspects the Soulbrand.

## The Hunt

Deserters are the Guild's greatest liability. [[Korrath]] leads a dedicated team of hunters who track down anyone who leaves. Most deserters are brought back and pushed to Stage 3 as punishment. [[Valen Ashwick]] has evaded them for five years -- an embarrassment the Guild takes personally.
```

---

### 6. Story / plot arc

For plot events, story arcs, or narrative beats. Story entries don't use `fileClass`.

```markdown
---
tags:
  - lorebook
keys:
  - Ashwick conspiracy
  - Guild conspiracy
  - the truth about the Guild

priority: 45
summary: "Ongoing plot arc about Valen uncovering the full scope of the Ironveil Guild's Soulbrand program. Select when investigation, conspiracy, exposing secrets, or confronting the Guild comes up. Central story arc."
---

# The Ashwick Conspiracy

The central storyline following [[Valen Ashwick]]'s quest to expose the [[Ironveil Guild]]'s [[Soulbrand]] program and free those already branded.

## Current State

Valen knows the Soulbrand exists and how it progresses, but not how to safely remove it or who sits on the Iron Council. He's gathering allies and information while staying ahead of Guild hunters.

## Key Threads

- **The Iron Council** -- Who are the three leaders? Valen has no leads yet.
- **Safe removal** -- Is there a way to remove the brand without killing the host? The [[Arcanist's Archive]] may hold answers.
- **[[Korrath]]** -- Can he be turned, or is he too far gone at Stage 2?
- **Sera's secret** -- [[Sera Thornwick]] helped Valen escape but has never explained why she knew about the brand.

## Possible Escalation

If the Guild completes its army, they could challenge the northern lords directly. Valen estimates they need 100 Stage 3 soldiers -- they have about 40 and are accelerating recruitment.
```

---

### 7. Always-send (constant) entry

This entry is **always injected**, regardless of keywords or AI search. Use this for core world rules or setting context that should always be present.

```markdown
---
tags:
  - lorebook
  - lorebook-always

# Priority matters even for constants -- it controls injection order
priority: 10
---

# World Rules

This story is set in Greymarch, a low-fantasy setting where magic exists but is rare, feared, and poorly understood.

**Core rules:**
- Magic has a physical cost. Every spell drains the caster's stamina, health, or lifespan.
- There are no "good" or "evil" factions. Every group believes they're right.
- Death is permanent. There is no resurrection magic.
- The gods are silent. Whether they exist is debated. No divine intervention occurs.
```

Constants don't need `keys` or `summary` since they're always injected. You can still add them if you want the entry to also appear in AI search manifests.

---

### 8. Seed entry

Seed entries provide story context to the **AI search model** at the start of new chats. They help the AI understand your setting so it can make better selection decisions. Seed content is **not** injected into the writing AI.

```markdown
---
tags:
  - lorebook
  - lorebook-seed
keys:
  - Greymarch
  - the setting

priority: 15
summary: "Core setting overview for the Greymarch campaign. Seed entry -- provides context to AI search on new chats."
---

# Greymarch Setting Overview

Greymarch is a northern territory of crumbling fortresses, dense forests, and coastal cities built on trade and old grudges. Magic is rare and feared. The [[Ironveil Guild]] is the dominant military force. The noble houses are fractured and paranoid.

The story follows [[Valen Ashwick]], a deserter from the Guild who discovered they're building a soul-bound army. He's gathering allies -- [[Sera Thornwick]], information broker; and whoever he can trust -- to expose the conspiracy before the Guild's army is complete.

Key factions: [[Ironveil Guild]] (antagonist), the Northern Lords (fractured, unaware), the [[Arcanist's Archive]] (neutral scholars), and various independent operators in the [[The Drowned Lantern|Docks district]].
```

---

### 9. Bootstrap entry

Bootstrap entries are **force-injected when the chat is short** (at or below the new chat threshold, default 3 messages). After that, they become regular keyword entries. Use this for context that's essential in early messages but not needed once the conversation is established.

```markdown
---
tags:
  - lorebook
  - lorebook-bootstrap
keys:
  - Valen
  - Ashwick

priority: 20
summary: "Protagonist quick-reference. Bootstrap entry -- force-injected at chat start, then becomes keyword entry."
---

# Valen Ashwick - Quick Reference

Valen Ashwick is the protagonist. He's a half-elf spellsword, mid-30s, sardonic and guarded. He deserted the [[Ironveil Guild]] five years ago after discovering the [[Soulbrand]] program. He fights with twin short swords and shadow magic.

**Current situation:** On the run from Guild hunters. Working as a mercenary out of the [[The Drowned Lantern|Docks district]]. Trusts [[Sera Thornwick]] and almost no one else.

**Voice:** Dry humor, avoids titles, speaks in short sentences when tense. Opens up slightly around people he trusts.
```

---

### 10. Conditional gating (requires / excludes)

Use `requires` to make an entry activate only when other specific entries are also matched. Use `excludes` to block an entry when certain entries are present.

```markdown
---
tags:
  - lorebook
keys:
  - Valen's scar
  - brand scar
  - wrist scar

priority: 50

# This entry only activates if BOTH Valen Ashwick AND The Soulbrand
# are also matched in the same generation.
requires:
  - Valen Ashwick
  - The Soulbrand

# This entry is blocked if the following entry is matched.
# Useful for mutually exclusive states or spoiler prevention.
excludes:
  - Brand Removed

summary: "Description of Valen's burned Soulbrand scar. Only relevant when both Valen and the Soulbrand are being discussed. Select when the scar is examined, the brand's residual effects, or Valen's past with the Guild comes up."
---

# Valen's Brand Scar

The scar on Valen's left wrist is a raised, blackened sigil -- the remains of his [[Soulbrand]], burned away with alchemical fire. It still aches in the presence of branded Guild members, and faintly pulses when he uses shadow magic.

He keeps it wrapped in leather. When asked, he says it's a burn from a forge accident. [[Sera Thornwick]] is one of the few who's seen it unwrapped.
```

---

### 11. Per-entry injection override

Override where and how this specific entry is injected, regardless of global settings. See [[Settings Reference]] for the global defaults.

```markdown
---
tags:
  - lorebook
keys:
  - inner thoughts
  - Valen thinks
  - internal monologue

priority: 25

# Override injection position for this entry only.
# "before" = before the main prompt
# "after" = after the main prompt
# "in_chat" = inserted between chat messages at the specified depth
position: in_chat

# How many messages from the bottom to inject (only used with in_chat).
# depth: 1 = just before the last message, 2 = before the second-to-last, etc.
depth: 1

# What role the injected message appears as.
# "system" = system message (invisible to the "characters")
# "user" = appears as a user message
# "assistant" = appears as an assistant message
role: system

summary: "Valen's internal monologue style guide. Select when the scene is introspective, emotionally charged, or involves difficult decisions."
---

# Valen's Inner Voice

When writing Valen's internal thoughts, follow these guidelines:

- Short, fragmented sentences when stressed ("Not again. Not here. Move.")
- Longer, more reflective prose when safe or alone
- He mentally argues with himself, sometimes addressing his past self
- He suppresses emotion by cataloguing his surroundings ("Three exits. Two armed. The barkeep's reaching under the counter.")
- Genuine vulnerability only surfaces around [[Sera Thornwick]], and even then, reluctantly
```

---

### 12. Cooldown and warmup

**Cooldown** prevents an entry from triggering again for N generations after it fires. **Warmup** requires a keyword to appear N or more times total in the scan text before the entry triggers.

```markdown
---
tags:
  - lorebook
keys:
  - weather
  - rain
  - storm
  - fog

priority: 70

# After this entry triggers, skip it for the next 5 generations.
# Prevents atmospheric descriptions from repeating too often.
cooldown: 5

# The keyword must appear at least 2 times total in the scan text
# before this entry triggers. Prevents one-off mentions from pulling
# in the entry.
warmup: 2

summary: "Greymarch weather patterns and atmospheric descriptions. Select when weather, climate, travel conditions, or outdoor scenes come up. Low priority flavor entry."
---

# Greymarch Weather

The northern coast of Greymarch is defined by its weather. Fog rolls in from the sea most mornings, burning off by midday only to return at dusk. Rain is frequent -- not the dramatic downpours of the south, but a persistent, cold drizzle that soaks through everything.

**Seasonal patterns:**
- **Spring:** Dense fog, intermittent rain, muddy roads
- **Summer:** Brief and mild. The only reliable sunshine. Fog lifts by mid-morning.
- **Autumn:** Storms off the coast. Heavy wind. Ships avoid the harbor.
- **Winter:** Bitter cold, sleet, occasional snow. The Docks district floods regularly.

Locals don't comment on the weather unless it's unusually clear. Sunshine is suspicious.
```

---

### 13. Refine keys (secondary keyword filter)

`refine_keys` adds a secondary AND filter on top of primary keywords. When set, a primary `keys` match alone isn't enough: at least one refine key must **also** appear in the scan text. This reduces false positives for entries with common keywords.

```markdown
---
tags:
  - lorebook
keys:
  - Ironveil Guild
  - the Guild
  - Ironveil

# Primary keys match broadly. Refine keys ensure the conversation
# is actually about Guild *operations*, not just a passing mention.
refine_keys:
  - contract
  - mission
  - recruitment
  - branded
  - cell
  - hunters

priority: 40
summary: "Ironveil Guild operational details. Select when Guild missions, contracts, cell structure, or hunter operations come up."
---

# Ironveil Guild Operations

Detailed operational procedures for the Guild...
```

**How it works:** if "the Guild" appears in chat (primary match), the entry only triggers when at least one of `contract`, `mission`, `recruitment`, etc. also appears. Without refine keys, every mention of "the Guild" would pull this entry in.

---

### 14. Cascade links (auto-pull related entries)

`cascade_links` automatically pulls in other entries when the parent entry matches. No keyword check needed for the linked entries. Unlike wikilink recursion (which scans for keywords), cascade links are unconditional.

```markdown
---
tags:
  - lorebook
keys:
  - Soulbrand
  - soul brand
  - branded

priority: 35

# When the Soulbrand entry matches, automatically pull in
# the removal procedure entry too -- they're always relevant together.
cascade_links: ["Soulbrand Removal", "Ironveil Guild"]

summary: "Magical branding ritual used by the Ironveil Guild. Select when the brand, soul magic, or forced servitude comes up."
---

# The Soulbrand

A ritual binding developed by the [[Ironveil Guild]]...
```

**Use cases:**
- Lore mechanics that always travel together (e.g., a blood bond entry cascading to the feeding mechanics entry)
- Locations with sub-locations (e.g., a fortress cascading to its dungeon and armory)
- Characters with dedicated lore entries (e.g., a character cascading to their unique ability entry)

---

### 15. Constant via frontmatter

Beyond the `#lorebook-always` tag, you can make an entry constant by setting `constant: true` in frontmatter. Both methods are equivalent.

```markdown
---
tags:
  - lorebook

# This entry is always injected, same as adding the lorebook-always tag.
constant: true
priority: 10
---

# World Rules

Core rules that should always be present in context...
```

**When to use which:**
- `#lorebook-always` tag: quick, visible at a glance in Obsidian's tag system
- `constant: true` field: useful when you want to keep the tags array clean or when programmatically managing entries

---

### 16. Contextual gating

Use `era`, `location`, `scene_type`, and `character_present` fields to control when an entry injects based on the current story context. Set the active context with `/dle-set-era`, `/dle-set-location`, `/dle-set-scene`, `/dle-set-characters`, or use the generic `/dle-set-field <name> [value]` command.

These four fields are the defaults that ship out of the box. You can add, remove, or modify gating fields via the "Manage Fields" rule builder (accessible from the Filters tab toolbar or Settings popup). Custom field definitions are stored in `DeepLore/field-definitions.yaml` in your vault. Each field has a type (`string`, `number`, `boolean`), a gating operator (`match_any`, `match_all`, `not_any`, `exists`, `not_exists`, `eq`, `gt`, `lt`), and a tolerance level (`strict`, `moderate`, `lenient`). See [[Custom Fields]] for the full schema.

```markdown
---
tags:
  - lorebook
keys:
  - Docks smuggling
  - smuggler routes
  - contraband

priority: 50

# This entry only injects when:
# - The active era is "pre-war" (set via /dle-set-era pre-war)
# - The active location is "The Docks" (set via /dle-set-location The Docks)
# - The active scene type is "investigation" or "exploration"
# - Maren Blacktide is among the present characters
era: pre-war
location: The Docks
scene_type: investigation
character_present:
  - Maren Blacktide

summary: "Smuggling routes and contraband network in the Docks district during the pre-war era. Select when smuggling, black market, or Maren's operations come up."
---

# Docks Smuggling Network

The Docks district has been the center of Greymarch's smuggling operations for decades. [[Maren Blacktide]] controls the primary routes...
```

**How it works:**
- Entries without contextual fields are always eligible (they pass through unfiltered)
- Each field is checked independently: an entry with only `era` set is filtered only on era, regardless of location/scene/character
- Use `/dle-context-state` to see the current active context
- Context is stored per-chat in `chat_metadata.deeplore_context`

---

### 17. Outlet (macro-based injection)

Use the `outlet` field to inject an entry wherever you place the `{{outlet::name}}` macro instead of using positional injection. Useful for recurring lore that should appear at a specific spot in a system prompt or character card.

```markdown
---
tags:
  - lorebook
keys:
  - house rules

priority: 20
outlet: house_rules
summary: "Table rules block. Injected wherever {{outlet::house_rules}} appears in the prompt."
---

# House Rules

- No metagaming.
- One swipe, then commit.
- Players narrate their own thoughts; the GM narrates the world.
```

Place `{{outlet::house_rules}}` in your system prompt, character card, or any prompt-list slot, and DLE substitutes the entry's cleaned content at that point. Outlet entries skip the normal positional injection.

---

## Tips

- **Start simple.** A tag and some keywords is enough. Add fields as you need them.
- **Keywords are case-insensitive by default.** "Valen", "valen", and "VALEN" all match. You can change this in [[Settings Reference]].
- **Use wikilinks.** When entry A links to entry B with `[[Entry B]]`, recursive scanning can pull in related entries automatically.
- **Test with Context Cartographer.** After generating a message, check what was injected and why. See [[Features]] for details.
- **Summaries are for the search AI, not the writing AI.** Don't put character descriptions in summaries. Put *when to select this entry* in summaries.
- **Priority matters for constants too.** Even always-send entries use priority to determine injection order.
- **Don't over-tag.** An entry only needs `#lorebook`. Add special tags (`#lorebook-always`, etc.) only when you specifically need that behavior.
- **Run `/dle-lint` after authoring.** Catches common frontmatter footguns (case-wrong field names, comma-string `keys`, quoted numerics, missing fences) at once.
