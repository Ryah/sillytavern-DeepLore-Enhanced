# Duskfrost Test Vault

A synthetic Obsidian vault for DeepLore Enhanced QA. **~235 entries** covering every frontmatter field, gating mechanism, health-check condition, and graph topology. Versioned with the extension source.

**Theme:** Duskfrost — a sprawling fantasy city with factions, districts, pre-Calamity ruins, and political intrigue.

---

## Directory Structure

```
_edge-cases/     27 files — intentionally broken/weird entries
characters/      40 files — 10 full, 30 skeleton
events/          25 files — 3 full, 22 skeleton
items/           20 files — 3 full, 17 skeleton
locations/       35 files — 5 full, 30 skeleton
lore/            44 files — 9 full, 35 skeleton
meta/            10 files — all full (constants, seeds, world rules)
organizations/   20 files — 3 full, 17 skeleton
species/         15 files — 3 full, 12 skeleton
```

---

## Expected Health Check Results

Run `/dle-health` with this vault connected (default settings). Expected output:

### ERRORS (8)

| Entry | Error |
|-------|-------|
| `_edge-cases/_orphaned-requires.md` | requires non-existent entry "Nonexistent Entry XYZ" |
| `_edge-cases/_circular-requires-a.md` | circular requires chain with "Circular Requires B" |
| `_edge-cases/_circular-requires-b.md` | circular requires chain with "Circular Requires A" |
| `_edge-cases/_self-exclude.md` | entry excludes itself ("Self Exclude Entry") |
| `_edge-cases/_duplicate-title-a.md` | duplicate entry title "Duplicate Title Entry" |
| `_edge-cases/_duplicate-title-b.md` | duplicate entry title "Duplicate Title Entry" |
| `_edge-cases/_requires-excludes-contradiction.md` | requires AND excludes same title "Oracles of Might" |
| *(circular requires pair counts as 1 error per entry)* | |

### WARNINGS (10+)

| Entry | Warning |
|-------|---------|
| `_edge-cases/_empty-content.md` | entry has no content |
| `_edge-cases/_no-keywords.md` | entry has no trigger keywords |
| `_edge-cases/_probability-zero.md` | probability set to 0 — entry can never trigger |
| `_edge-cases/_cooldown-on-constant.md` | cooldown set on constant entry (no effect) |
| `_edge-cases/_depth-without-inchat.md` | depth override with non-in_chat position |
| `_edge-cases/_role-without-inchat.md` | role override with non-in_chat position |
| `_edge-cases/_oversized-entry.md` | entry exceeds 1500 tokens |
| `meta/duskfrost-timeline.md` | seed entry exceeds 2000 tokens |
| `_edge-cases/_short-keys.md` | keywords ≤2 chars (Li, Qi, ab, sk) — false match risk |
| *(shared keywords across entries, if detected)* | duplicate keyword warning |

### INFO

| Entry | Info |
|-------|------|
| `_edge-cases/_unresolved-links.md` | unresolved wiki-link targets |

### NOT INDEXED

| Entry | Reason |
|-------|--------|
| `_edge-cases/_disabled-entry.md` | `enabled: false` — skipped by indexer |
| `_edge-cases/_never-insert.md` | tagged `lorebook-never` — indexed but never injected |

---

## Feature Coverage Matrix

### Core Matching

| Feature | File |
|---------|------|
| Simple keyword (single key) | `species/gnaino.md` |
| Multi-keyword (5+ keys per entry) | `characters/felicitas-langguth.md` (7 keys) |
| Short keywords ≤2 chars | `_edge-cases/_short-keys.md` |
| Unicode keywords (CJK, Cyrillic) | `_edge-cases/_unicode-keys.md` |
| Regex special chars in keys | `_edge-cases/_regex-special-keys.md` |
| refine_keys (secondary gate) | `characters/ayre-waesphyra.md` |
| scanDepth: 0 (AI-only) | `lore/hidden-compact.md` |
| scanDepth: 50 (deep scan) | `characters/ayre-waesphyra.md` |
| scanDepth: 5 (custom) | `items/speaking-stone.md` |
| excludeRecursion: true | `characters/zoughat.md`, `organizations/marblesmiths.md`, `species/gnaino.md` |
| No keywords (health warn) | `_edge-cases/_no-keywords.md` |
| Duplicate keywords (health warn) | intentional overlap across some entries |

### Requires / Excludes Gating

| Feature | File(s) |
|---------|---------|
| requires — simple A→B | `characters/gorduin-wynlar.md` requires Oracles of Might |
| requires — chain A→B→C | `adelas-gilydark` → `gorduin-wynlar` → `Oracles of Might` |
| requires — circular (ERROR) | `_edge-cases/_circular-requires-a.md` + `_circular-requires-b.md` |
| requires — orphaned (ERROR) | `_edge-cases/_orphaned-requires.md` |
| excludes — simple | `organizations/bonehands.md` excludes Solarguard |
| excludes — mutual | `bonehands` ↔ `solarguard`, `zuni-dhegevnac` ↔ `grolgrurim-bluntgut` |
| excludes — self (ERROR) | `_edge-cases/_self-exclude.md` |
| requires + excludes contradiction (ERROR) | `_edge-cases/_requires-excludes-contradiction.md` |
| cascade_links — basic | `characters/gorduin-wynlar.md` → Oracles of Might, Bellsummit |
| cascade_links — target has cooldown | `items/angel-crown.md` → `lore/war-of-glimmering-hope.md` |

### Behavioral Gating

| Feature | File |
|---------|------|
| warmup: 1 | `characters/grolgrurim-bluntgut.md` |
| warmup: 3 | `characters/snugug.md`, `lore/battle-of-the-false-prophet.md` |
| cooldown: 1 | `characters/grolgrurim-bluntgut.md` |
| cooldown: 2 | `items/angel-crown.md` |
| cooldown: 3 | `items/resurrection-jar.md` |
| cooldown: 5 | `characters/kabugbu.md` |
| cooldown on constant (WARN) | `_edge-cases/_cooldown-on-constant.md` |
| probability: 0.1 | `characters/kabugbu.md` |
| probability: 0.3 | `items/tiara-of-teleportation.md` |
| probability: 0.4 | `items/severance-dagger.md` |
| probability: 0.5 | `characters/tybellan-hercyne.md`, `items/sword-of-enigmas.md` |
| probability: 0.7 | `items/angel-crown.md` |
| probability: 1.0 | `items/elemental-band.md` |
| probability: 0 (WARN) | `_edge-cases/_probability-zero.md` |

### Contextual Gating (era / location / scene_type / character_present)

| Feature | File |
|---------|------|
| era — single string | `events/war-of-the-broken-mountain.md` (`era: medieval`) |
| era — array | `characters/ayre-waesphyra.md` (`era: [medieval, renaissance]`) |
| era — absent (always matches) | `characters/gorduin-wynlar.md` |
| location — single string | `locations/bellsummit.md` (`location: Bellsummit`) |
| location — array | `lore/binding-compact.md` (`location: [Bellsummit, Scorchhelm]`) |
| scene_type — single | `events/war-of-the-broken-mountain.md` (`scene_type: combat`) |
| scene_type — array | `locations/scorchhelm.md` (`scene_type: [combat, exploration]`) |
| scene_type — social | `locations/the-hidden-dragonfruit-tavern.md` |
| character_present — single | `items/angel-crown.md` (`character_present: [Gorduin Wynlar]`) |
| character_present — multiple (AND) | `characters/felicitas-langguth.md` (`character_present: [Gorduin Wynlar, Ayre Waesphyra]`) |
| All 4 fields combined | `lore/solstice-ritual.md` |
| tolerance=strict blocks all-gated | test scenario 8 below |
| tolerance=lenient allows all-gated | test scenario 9 below |

### Injection Position / Role

| Feature | File |
|---------|------|
| position: before | `locations/east-hamp.md` |
| position: after | `locations/saseopt-district.md` |
| position: in_chat, depth: 0 | `locations/south-sool.md` |
| position: in_chat, depth: 4 | `locations/chorstap-row.md` |
| position: in_chat, role: system | `meta/duskfrost-world-rules.md` |
| position: in_chat, role: user | `lore/oracles-summit.md` |
| position: in_chat, role: assistant | `lore/scribe-fragment.md` |
| depth without in_chat (WARN) | `_edge-cases/_depth-without-inchat.md` |
| role without in_chat (WARN) | `_edge-cases/_role-without-inchat.md` |

### Special Entry Types

| Feature | File(s) |
|---------|---------|
| Constant (lorebook-always) | `meta/duskfrost-world-rules.md`, `meta/duskfrost-geography.md`, `meta/duskfrost-triumvirate.md`, `meta/duskfrost-law-enforcement.md`, `species/zuvine.md`, `species/cirilae.md` |
| Seed (lorebook-seed) | `meta/duskfrost-tone-guide.md`, `meta/duskfrost-era-guide.md`, `meta/duskfrost-timeline.md` |
| Seed oversized >2000 tok (WARN) | `meta/duskfrost-timeline.md` |
| Bootstrap (lorebook-bootstrap) | `meta/duskfrost-magic-system.md`, `species/bolludine.md` |
| Disabled (enabled: false) | `_edge-cases/_disabled-entry.md` |
| Never-insert (lorebook-never) | `_edge-cases/_never-insert.md` |

### Content / Parsing Edge Cases

| Feature | File |
|---------|------|
| Wiki-links `[[Target]]` | most full entries |
| Wiki-links with display `[[T\|Display]]` | several lore entries |
| Unresolved wiki-links (INFO) | `_edge-cases/_unresolved-links.md` |
| Image embeds `![[img.png]]` (stripped) | `_edge-cases/_image-embeds.md` |
| Obsidian comments `%%...%%` (stripped) | `_edge-cases/_obsidian-comments.md` |
| deeplore-exclude blocks (stripped) | `_edge-cases/_deeplore-exclude-block.md` |
| HTML `<div class="meta-block">` (kept) | all full entries |
| First H1 heading (stripped) | all entries with `# Title` |
| UTF-8 BOM prefix (stripped) | `_edge-cases/_bom-prefix.md` |
| YAML block scalar summary `\|` | `_edge-cases/_block-scalar-summary.md` |
| Inline array keys `keys: [a, b]` | `_edge-cases/_inline-array-keys.md` |
| Number summary `summary: 42` | `_edge-cases/_number-summary.md` |
| Oversized content >1500 tok (WARN) | `_edge-cases/_oversized-entry.md` |
| Empty content (WARN) | `_edge-cases/_empty-content.md` |
| No summary (no AI warn w/ AI off) | several skeleton entries |
| Duplicate titles (ERROR) | `_duplicate-title-a.md` + `_duplicate-title-b.md` |

### Graph Topology

| Topology Feature | Entries |
|-----------------|---------|
| Hub node (10+ connections) | `characters/gorduin-wynlar.md` |
| Dense cluster (5+ mutual links) | gorduin-wynlar, ayre-waesphyra, oracles-of-might, bellsummit, duskfrost-magic-system |
| Isolated pair (no other links) | `events/assault-of-broken-love.md` ↔ `events/battle-of-vryhs.md` |
| Orphan nodes (no links) | Most items/ entries |
| Mutual excludes edges | bonehands ↔ solarguard, zuni-dhegevnac ↔ grolgrurim-bluntgut |
| Requires chain (directional) | adelas → gorduin → oracles-of-might |
| Cascade chain | angel-crown → war-of-glimmering-hope |

---

## Entry Relationship Graph

```
REQUIRES CHAIN (A must match before B triggers):
  Adelas Gilydark ──requires──► Gorduin Wynlar ──requires──► Oracles of Might

MUTUAL EXCLUDES (cannot appear together):
  Bonehands ◄──excludes──► Solarguard
  Zuni Dhegevnac ◄──excludes──► Grolgrurim Bluntgut

CASCADE LINKS (B auto-injects when A matches):
  Gorduin Wynlar ──cascade──► Oracles of Might
  Gorduin Wynlar ──cascade──► Bellsummit
  Gorduin Wynlar ──cascade──► Duskfrost Magic System
  Sarros Sylren ──cascade──► War of Glimmering Hope
  Angel Crown ──cascade──► War of Glimmering Hope
  Bellsummit ──cascade──► Oracles of Might
  Bellsummit ──cascade──► Duskfrost Academy

DENSE CLUSTER (all link to each other):
  ┌─────────────────────────────────────────────────────┐
  │  Gorduin Wynlar ── Ayre Waesphyra                   │
  │       │                  │                          │
  │  Oracles of Might ── Bellsummit                     │
  │       │                  │                          │
  │  Duskfrost Magic System ──────────────────────────  │
  └─────────────────────────────────────────────────────┘

ISOLATED PAIR (only links to each other):
  Assault of Broken Love ◄──► Battle of Vryhs

ORPHAN NODES (no links):
  ~13 items/ entries (canopic-chest, divine-tiara, truth-vial, etc.)
```

---

## Manual QA Test Scenarios

### Scenario 1: Era Gating
1. `/dle-set-era medieval`
2. Send: "Tell me about the war"
3. **Expect:** `events/war-of-the-broken-mountain.md`, `lore/war-of-glimmering-hope.md`, `lore/battle-of-the-false-prophet.md` eligible
4. **Expect NOT:** `events/war-of-kroyhr.md` (era: ancient), `events/battle-of-the-vanguard-crossing.md` (era: reconstruction)

### Scenario 2: Location Gating
1. `/dle-set-location Bellsummit`
2. Send: "I walk through Gorduin's office"
3. **Expect:** `characters/gorduin-wynlar.md` AND `locations/bellsummit.md` inject (both match location)
4. **Expect NOT:** `lore/oracles-summit.md` (requires character_present Ayre Waesphyra)

### Scenario 3: Cascade Links
1. Send: "The Angel Crown sits in the vault"
2. **Expect:** `items/angel-crown.md` matches AND `lore/war-of-glimmering-hope.md` auto-injects via cascade
3. **Expect:** On next generation mentioning Angel Crown — no injection (cooldown:2)

### Scenario 4: Requires Chain (3-deep)
1. Send: "Adelas is cataloguing today"
2. **Expect:** `characters/adelas-gilydark.md` does NOT inject (requires Gorduin, who is not matched)
3. Send: "Gorduin and Adelas are cataloguing"
4. **Expect:** Both inject (Gorduin matched, so Adelas's require is satisfied; Gorduin requires Oracles of Might which must be in vault)

### Scenario 5: Mutual Excludes
1. Send: "The Bonehands collect tribute on the docks"
2. **Expect:** `organizations/bonehands.md` injects; `organizations/solarguard.md` does NOT inject
3. Send: "The Solarguard patrols Scorchhelm"
4. **Expect:** `organizations/solarguard.md` injects; `organizations/bonehands.md` does NOT inject

### Scenario 6: Warmup (3 occurrences required)
1. Send: "Snugug is at the docks" → **Expect:** no injection (count 1)
2. Send: "Snugug blocks the entrance" → **Expect:** no injection (count 2)
3. Send: "Snugug steps forward" → **Expect:** injection (count 3, warmup satisfied)

### Scenario 7: Cooldown (skip 1 generation)
1. Send: "Grolgrurim negotiates" → **Expect:** `characters/grolgrurim-bluntgut.md` injects (warmup:1 satisfied)
2. Send: "Grolgrurim continues the meeting" → **Expect:** no injection (cooldown:1 — skip 1 generation)
3. Send: "Grolgrurim stands up" → **Expect:** injects again (cooldown expired)

### Scenario 8: All-4-Fields Gating (strict blocks)
1. Clear all context: `/dle-set-era`, `/dle-set-location`, etc. (no active context)
2. Set tolerance to `strict` in settings
3. Send: "The solstice ceremony begins" (matches `lore/solstice-ritual.md` keywords)
4. **Expect:** No injection — `solstice-ritual.md` requires all 4 gating fields; none are set; strict mode blocks

### Scenario 9: All-4-Fields Gating (lenient allows)
1. Same setup as Scenario 8, but set tolerance to `lenient`
2. Send: "The solstice ceremony begins"
3. **Expect:** Injection — lenient mode allows entries even when their gating context is not fully set

### Scenario 10: character_present (multi-character AND)
1. Set character_present to only Gorduin Wynlar (not Ayre)
2. Send: "Felicitas arrives at the meeting"
3. **Expect:** `characters/felicitas-langguth.md` does NOT inject (requires BOTH Gorduin AND Ayre present)
4. Set character_present to include both Gorduin Wynlar and Ayre Waesphyra
5. Send: "Felicitas arrives at the meeting"
6. **Expect:** Injection

### Scenario 11: Health Check Validation
1. Connect this vault in a test vault config
2. Run `/dle-rebuild`
3. Run `/dle-health`
4. **Verify:** 7+ errors including circular requires, self-exclude, duplicate titles, orphaned requires, requires+excludes contradiction
5. **Verify:** 9+ warnings including empty content, probability zero, cooldown-on-constant, oversized entries, short keywords
6. **Verify:** 1 info: unresolved wiki-link

### Scenario 12: Graph Topology
1. Run `/dle-graph`
2. **Verify:** Gorduin Wynlar is a hub node with many connections
3. **Verify:** Assault of Broken Love and Battle of Vryhs appear as an isolated pair
4. **Verify:** Most items/ entries appear as orphan nodes
5. **Verify:** Oracles of Might cluster is visible (gorduin, ayre, bellsummit, oracles-tower, etc.)
6. **Verify:** Bonehands and Solarguard show excludes edges (if rendered)

### Scenario 13: refine_keys Gate
1. Send: "Ayre is working today"
2. **Expect:** `characters/ayre-waesphyra.md` does NOT inject (keyword "Ayre" matches, but refine_keys [ancient, elder, pre-Calamity] not present in text)
3. Send: "Ayre is studying ancient texts"
4. **Expect:** Injection (both primary key AND refine_key satisfied)

### Scenario 14: AI-Only Entry (scanDepth: 0)
1. Enable AI search, set to two-stage mode
2. Send: "There's a secret agreement between the houses"
3. **Expect:** `lore/hidden-compact.md` appears in AI results (AI can find it semantically)
4. **Verify:** It does NOT appear in keyword-only mode (scanDepth: 0 means no keyword scanning)

### Scenario 15: Injection Position Verification
1. Send any message that matches `locations/east-hamp.md` keywords ("East Hamp")
2. **Verify:** Injected BEFORE the chat (position: before)
3. Match `locations/saseopt-district.md` ("Saseopt")
4. **Verify:** Injected AFTER the chat (position: after)
5. Match `locations/south-sool.md` ("South Sool")
6. **Verify:** Injected IN CHAT at depth 0 (most recent message position)

---

## Vault Entry Index

### characters/ (40 entries)
Full: gorduin-wynlar, ayre-waesphyra, zuni-dhegevnac, grolgrurim-bluntgut, tybellan-hercyne, sarros-sylren, felicitas-langguth, adelas-gilydark (skeleton w/ requires), snugug (skeleton w/ warmup), kabugbu (skeleton w/ cooldown+prob)

Skeleton: zoughat, kieran-heixisys, erlathan-ercyne, vulfun-gurdoth, dhymma-dherignol, orirbak-kegfeet, jafrom-deepbeard, dorian-schmitt, kasper-lampi, cecilie-sorensen, + 20 more varied characters

### events/ (25 entries)
Full: war-of-the-broken-mountain, battle-of-the-vanguard-crossing, founding-of-the-solarguard
Skeleton (22): assault-of-broken-love, battle-of-vryhs, war-of-kroyhr, attack-of-steel, siege-of-am, night-of-empty-chairs, academy-fire-of-211, velkhast-succession-crisis, resonance-discovery, first-triumvirate-compact, calamity-onset, great-census-of-180, harbour-expansion-project, scar-mapping-expedition, bonehands-founding, watchers-treaty, archive-disappearance, great-flood-of-highwallow, morveth-arcane-monopoly-broken, champions-founding, oracles-schism, zuvine-harbor-treaty

### items/ (20 entries)
Full: angel-crown, sword-of-enigmas, mirror-of-binding
Skeleton (17): elemental-band, resurrection-jar, tiara-of-teleportation, canopic-chest-of-serendipity, hells-statue, divine-tiara, jar-of-paradise, speaking-stone, truth-vial, heartwood-staff, ghost-lantern, nullifying-gauntlet, bone-compass, archive-key, echo-lens, severance-dagger, weight-of-regret

### locations/ (35 entries)
Full: bellsummit, amberburgh, bayside-shushail, scorchhelm, the-hidden-dragonfruit-tavern
Skeleton (30): south-sool, chorstap-row, east-hamp, saseopt-district, rappiop-grove, highwallow, rimeborough, redpond, the-majestic-boulder, the-jealous-librarian, ye-olde-guinea-pig-inn, scorchhelm-training-grounds, archive-building, resonance-observatory, hollow-road-entrance, compact-vault-scorchhelm, amberburgh-exchange, highwallow-mutual-aid-hall, bolludine-quarter, zuvine-harbor-district, champions-chapel, solarguard-headquarters, academy-main-hall, bonehands-counting-house, the-drowned-anchor, oracles-tower, highwallow-night-clinic, cliff-stairs, redpond-waterfront, rimeborough-market

### lore/ (44 entries)
Full: war-of-glimmering-hope, battle-of-the-false-prophet, binding-compact, oracles-summit, solstice-ritual, hidden-compact, scribe-fragment, siege-of-am-lore, attack-of-lost-friends
Skeleton (35): resonance-scar-properties, antecedent-script, hollow-roads, sigil-theory, blood-binding, true-names, resonance-frequency-theory, calamity-theories, arcane-bloodline-inheritance, ley-line-geography, reconstruction-oral-history, + 24 more covering all era/location/scene_type combos

### meta/ (10 entries, all full)
duskfrost-world-rules (constant, in_chat/system), duskfrost-geography (constant), duskfrost-tone-guide (seed), duskfrost-era-guide (seed), duskfrost-magic-system (bootstrap), duskfrost-triumvirate (constant), duskfrost-timeline (seed, oversized), duskfrost-law-enforcement (constant), duskfrost-academy (standard), duskfrost-currency (skeleton)

### organizations/ (20 entries)
Full: oracles-of-might, solarguard, champions-of-patience
Skeleton (17): marblesmiths (excludeRecursion), bonehands (mutual excludes), mages-of-the-patient, scourge-vitality, velkhast-trading-co, harcyne-granaries, wardenship, bellsummit-council, amberburgh-merchants-league, salvagers-compact, keepers-of-the-scar, old-harbor-brotherhood, highwallow-mutual-aid, academy-fellowship, redpond-fishers, thornwick-society, night-market-guild

### species/ (15 entries)
Full: zuvine (constant), cirilae (constant), bolludine (bootstrap)
Skeleton (12): gnaino (excludeRecursion), lorant, delivese, bhissalae, kethvali, thyren, velhari, vorruk, selaveth, crennish, orvathi, halfblood-notes

### _edge-cases/ (27 entries)
_empty-content, _orphaned-requires, _circular-requires-a, _circular-requires-b, _self-exclude, _disabled-entry, _never-insert, _oversized-entry, _no-keywords, _regex-special-keys, _unicode-keys, _short-keys, _probability-zero, _cooldown-on-constant, _depth-without-inchat, _role-without-inchat, _bom-prefix, _block-scalar-summary, _inline-array-keys, _number-summary, _duplicate-title-a, _duplicate-title-b, _unresolved-links, _obsidian-comments, _deeplore-exclude-block, _image-embeds, _requires-excludes-contradiction

---

## How to Use This Vault

### Manual QA
1. Add a test vault config pointing at this directory
2. Run `/dle-rebuild` — should index ~230 entries (minus disabled entry)
3. Run through scenarios above
4. Run `/dle-health` — verify errors/warnings match expected list

### Health Check Baseline
The expected errors and warnings above serve as the baseline. Any deviation (extra warnings, missing errors) indicates a health check regression.

### Graph Testing
Run `/dle-graph` after indexing. Use the topology descriptions above to verify cluster rendering, hub node visibility, isolated pairs, and orphan nodes.

### Future Automated Tests
Integration tests can read vault files directly, call `buildIndex()`, and assert matching behavior against known inputs without requiring a running Obsidian instance. The deterministic content makes assertions stable.
