# What is DeepLore?

## The Problem: AI Has No Memory

When you roleplay with an AI in SillyTavern, the AI only sees what's in the current prompt: the character card, the system prompt, and the most recent chat messages. It has no persistent memory of your world. If your story has a hundred characters, three factions, a magic system, and a political history, the AI doesn't know any of that unless you tell it — every single time.

This is where a **lorebook** comes in.

## What's a Lorebook?

A lorebook is a collection of reference entries about your fictional world — characters, locations, factions, lore, items, history, rules. Each entry has **trigger keywords** that tell the system when to inject that entry into the AI's context.

When you send a message mentioning "the Silver Court," the lorebook finds the entry tagged with that keyword and quietly injects its contents into the prompt behind the scenes. The AI reads it as if it always knew about the Silver Court. The result: consistent, grounded storytelling where the AI respects your worldbuilding.

SillyTavern has a built-in lorebook system called **World Info**. It works. So why would you want something different?

## Why DeepLore Enhanced?

DeepLore Enhanced (DLE) is an alternative lorebook system that stores your entries in an **Obsidian vault** instead of SillyTavern's internal JSON files. This changes the workflow in several meaningful ways:

**Your lore lives in Obsidian, not in SillyTavern.** Obsidian is a powerful writing tool with backlinks, graph views, templates, and a plugin ecosystem. You can organize your world with folders, tags, and cross-references. Your lore is plain markdown files on your disk — not locked inside a JSON blob that's hard to browse or edit.

**AI-powered entry selection.** World Info only matches exact keywords. DLE can optionally run a second pass where an AI model reads the recent conversation and a summary of your vault, then selects entries that are contextually relevant — even when no exact keyword appears. A conversation about "the consequences of breaking an oath" can pull in your entry about Bloodchains without the word "Bloodchain" ever being mentioned.

**Richer entry behavior.** DLE supports features that World Info doesn't: cooldowns (don't repeat the same lore every message), warmup (require a topic to come up multiple times before injecting detailed lore), conditional gating (entry A only activates when entry B is also active), contextual filtering by era/location/scene type, cascade links (when one entry activates, pull in its related entries automatically), fuzzy search, entry decay, and more.

**Diagnostic tools.** When something isn't working, DLE tells you why. The Context Cartographer shows exactly which entries were injected into each message. The "Why Not?" diagnostic traces an unmatched entry through every pipeline stage and tells you where it was filtered out. The health check audits your entire vault for misconfiguration.

**Session Scribe and Auto Lorebook.** DLE can automatically summarize your roleplay sessions back into your Obsidian vault as timestamped notes. It can also analyze your chat and suggest new lorebook entries for characters, locations, or concepts that came up in conversation but don't have entries yet.

## How the Pipeline Works

Here's the mental model for what happens every time you (or the AI) sends a message:

```
You send a message
        |
        v
  [1] Build scan text
      DLE looks at the last N messages (your "scan depth")
      and concatenates them into a block of text to search.
        |
        v
  [2] Keyword matching
      Every entry's keywords are checked against the scan text.
      Entries that match are collected as candidates.
      Constants (always-on entries) are added automatically.
        |
        v
  [3] AI selection (optional)
      If AI search is enabled, a compact summary of the candidates
      is sent to an AI model along with the recent chat.
      The AI picks the entries that are actually relevant right now.
        |
        v
  [4] Filtering
      Pins and blocks are applied. Contextual gating checks
      era/location/scene. Requires/excludes rules are evaluated.
      Cooldowns and deduplication are enforced.
        |
        v
  [5] Budget and formatting
      Entries are sorted by priority. The token budget and max
      entries caps are applied. Entries are formatted and grouped
      by injection position.
        |
        v
  [6] Injection
      The formatted entries are injected into the prompt.
      The writing AI sees them as part of its context.
        |
        v
  The AI generates a response informed by your lore.
```

Steps 2 and 3 are the "two-stage" pipeline that gives DLE its name. Keywords cast a wide net; the AI narrows it down. If AI search is disabled, step 2 alone determines the results (keywords-only mode).

The key insight is that **you don't need to think about any of this while writing**. You write your story; DLE handles the lore injection in the background. The diagnostic tools are there for when you want to understand or tune the behavior.

## Who is DLE For?

DLE is built for creative writers who:

- Have a developed fictional world with characters, locations, factions, and lore they want the AI to respect
- Already use (or want to use) Obsidian as their worldbuilding tool
- Want more control over when and how lore is injected than World Info provides
- Are willing to spend a few minutes setting up an Obsidian vault and writing entries with frontmatter

If you have a handful of simple entries and World Info does what you need, you probably don't need DLE. If you have a sprawling world with dozens or hundreds of entries and you want the AI to be smart about which ones matter right now, DLE is built for that.

## Next Steps

- [[Quick Start]] — Get DLE injecting lore in 5 minutes
- [[Writing Vault Entries]] — How to create entries with the right frontmatter
- [[Features]] — Catalog of all features with links to detail pages
- [[Pipeline]] — Detailed technical explanation of the matching pipeline
