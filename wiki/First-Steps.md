# First Steps

You've installed DeepLore Enhanced and connected your vault ([Quick Start](Quick-Start)). Now what? This guide walks you through building a useful lore vault and tuning the extension for your needs.

## Understanding the Pipeline

DeepLore works in three modes:

| Mode | How It Works | Cost | Best For |
|------|-------------|------|----------|
| **Keyword Only** | Scans recent chat messages for keywords defined in your entries | Free | Small vaults (<50 entries), simple setups |
| **Two-Stage** | Keywords pre-filter candidates, then AI picks the best matches | 1-2 API calls/generation | Medium vaults (50-200 entries) |
| **AI Only** | AI evaluates the full vault directly | 1+ API calls/generation | Large vaults, complex lore, best results |

Start with **Keyword Only** to learn the system, then upgrade to **Two-Stage** when your vault grows.

## Writing Your First Entries

A good starter vault has 3-5 entries covering:

### 1. A Character Entry
```yaml
---
tags: [lorebook]
keys: [Eris, the Spymaster]
priority: 20
summary: "Eris, the protagonist's spymaster and closest enforcer. Select when espionage, intelligence, interrogation, or loyalty comes up."
---
```
- **Priority 20** = important character (inner circle)
- Keys include name and title/role

### 2. A Location Entry
```yaml
---
tags: [lorebook]
keys: [The Crimson Den, tavern, underground bar]
priority: 50
summary: "An underground tavern serving as a neutral meeting ground. Select when taverns, drinking, underground dealings, or nightlife come up."
---
```
- **Priority 50** = standard importance
- Keys include the name AND generic terms that would trigger it

### 3. A Lore Concept Entry
```yaml
---
tags: [lorebook]
keys: [bloodbond, blood bond, feeding dependency]
priority: 35
summary: "The biological dependency created when a vampire feeds from a mortal. Select when feeding, biting, addiction, or chattel dynamics come up."
---
```
- **Priority 35** = core lore
- Multiple keyword variants catch different phrasings

## Constants vs Triggered Entries

- **Regular entries** (just `lorebook` tag): Only injected when keywords match
- **Constants** (add `lorebook-always` tag): Always injected, every generation. Use for core world rules, character sheets, or writing instructions
- **Bootstrap entries** (add `lorebook-bootstrap` tag): Force-injected when chat is short (first few messages), then become regular entries
- **Seed entries** (add `lorebook-seed` tag): Content sent to AI as context for better entry selection on new chats (NOT injected into the writing AI)

**Rule of thumb:** Keep constants minimal. Every constant uses context budget on every generation.

## Tuning Scan Depth and Budget

### Scan Depth
How many recent chat messages DeepLore scans for keywords:
- **2-3**: Only matches recent conversation topics (responsive but narrow)
- **4-6**: Good default balance (recommended starting point)
- **8-10**: Broader matching, may pull in less relevant entries
- **0**: Disables keyword scanning entirely (use with AI-only mode)

### Token Budget
Maximum tokens DeepLore can inject per generation:
- **1000-2000**: Conservative, good for smaller contexts
- **3000-5000**: Balanced, works for most setups
- **Unlimited**: Let DeepLore use as much as it needs (watch your context usage)

Start with **scan depth 4** and **budget 3000**, then adjust based on `/dle-inspect` results.

## Enabling AI Search

When you're ready for smarter matching:

1. Go to **Search Mode** → select **Two-Stage**
2. Under **AI Search** (in Advanced), pick a connection mode:
   - **Profile**: Uses a SillyTavern Connection Manager profile (recommended)
   - **Proxy**: Routes through a CORS proxy (for advanced setups)
3. Select or create a connection profile with a fast, cheap model (Claude Haiku, GPT-4o-mini, etc.)
4. Test with `/dle-status` — it should show "AI search: enabled"

AI search shines when your vault is large or entries have nuanced triggers that keywords can't capture.

## Checking Entry Quality

Run `/dle-health` regularly. It checks for:
- Missing or empty keywords
- Duplicate keywords across entries
- Missing summaries (needed for AI search)
- Entries too large (may dominate your budget)
- Broken wikilinks
- Configuration issues

Aim for grade **A** or **A+**.

## Verifying What's Injecting

Three tools help you see what's happening:

1. **`/dle-inspect`** — Shows the last pipeline trace: what matched, why, and what was injected
2. **Context Cartographer** (Map button) — Shows sources from the last generation with token counts
3. **`/dle-simulate`** — Replays the entire chat showing which entries activate at each message

## Common Early Mistakes

| Mistake | Fix |
|---------|-----|
| Too many constants | Keep constants under 5-10. Use keywords for everything else |
| Keywords too generic | "the", "and", "said" will match everything. Use specific terms |
| Keywords too specific | "Lord Vexathorn the Undying" won't match "Vexathorn". Add aliases |
| No summaries | AI search needs summaries to work. Write them for every entry |
| Huge entries (5000+ tokens) | Split into smaller focused entries or use scan depth overrides |
| All priority 50 | Use the full range: 20 (critical), 35 (core), 50 (standard), 60+ (flavor) |

## Next Steps

- Read **[Features](Features)** for the full feature reference
- Check **[AI Search](AI-Search)** for advanced AI configuration
- See **[Writing Vault Entries](Writing-Vault-Entries)** for complete frontmatter reference
- Browse **[Slash Commands](Slash-Commands)** for all available commands
- If something breaks, check **[Troubleshooting](Troubleshooting)**
