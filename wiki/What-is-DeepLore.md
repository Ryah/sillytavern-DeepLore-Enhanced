<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/full-logo-darkmode.png">
    <source media="(prefers-color-scheme: light)" srcset="images/full-logo-lightmode.png">
    <img alt="DeepLore" src="images/full-logo-lightmode.png">
  </picture>
</p>

# What is DeepLore?

DeepLore is a lorebook system for SillyTavern that stores its entries in an Obsidian vault and uses an AI to pick the right ones at generation time. This page covers the problem it solves, what changes versus SillyTavern's built-in World Info, and the mental model for what runs on every message.

## The problem: the AI has no memory of your world

When you roleplay in SillyTavern, the writing AI only sees the current prompt: the character card, the system prompt, and the most recent chat messages. It has no persistent memory of your world. If your story has a hundred characters, three factions, a magic system, and a political history, the writing AI knows none of that unless you put it in the prompt every time.

A **lorebook** solves this. It stores reference entries about your world (characters, locations, factions, items, history, rules) and injects the relevant ones into the prompt as the conversation needs them.

SillyTavern ships with a lorebook system called **World Info**. It works. The question is whether it scales for your vault.

## What is a lorebook

A lorebook is a collection of reference entries. Each entry has trigger keywords. When one of those keywords appears in recent chat, the entry's content gets injected into the prompt behind the scenes. The writing AI reads it as if it always knew that information.

The result is consistent, grounded storytelling. The AI respects your worldbuilding because the lorebook keeps reminding it what your worldbuilding says.

## Why DeepLore over World Info

World Info's keyword matching breaks down around 80-100 entries. You write a scene about the consequences of breaking an oath. Your Bloodchain entry stays cold. The word was never typed.

DeepLore (DLE) is an alternative lorebook system that stores entries in an **Obsidian vault** instead of SillyTavern's internal JSON files, and adds an AI selection layer on top of keyword matching. Four practical differences:

**Your lore lives in Obsidian, not in SillyTavern.** Obsidian gives you backlinks, graph views, templates, and a plugin ecosystem. Your lore is plain markdown files on disk. You can browse, edit, search, and version-control them with normal tools. World Info entries live inside SillyTavern's character card or as a JSON blob; editing them at scale is painful.

**Two-stage retrieval.** World Info matches exact keywords. DLE runs keyword matching first, then an AI reads compact summaries of the keyword candidates and picks the entries that actually fit the scene. A conversation about "the consequences of breaking an oath" pulls in your Bloodchain entry without the word "Bloodchain" appearing.

**Richer entry behavior.** DLE adds cooldowns (skip an entry for N generations after it fires), warmup (require a topic to come up multiple times before injecting), conditional gating (entry A only fires when entry B is also active), contextual filtering by era / location / scene type / characters, cascade links (one entry fires, its related entries get pulled in too), fuzzy keyword matching, entry decay, and per-chat pin and block overrides.

**Diagnostics that name the failure.** When something doesn't fire, DLE tells you why. The Context Cartographer (the per-message trace) shows which entries fired, in what stage, with what token cost. The "Why Not?" trace walks an entry through every pipeline stage and names the one that filtered it. The health check audits your vault for misconfiguration with 30+ automated checks.

**Session Scribe and Auto Lorebook.** DLE can summarize sessions back to your vault as timestamped notes. Auto Lorebook scans recent chat and proposes new entries for characters, places, or concepts that came up but aren't in your vault yet.

## The Librarian (Emma)

In v2, DLE adds **the Librarian**: writing-AI tools (`search` and `flag`) plus Emma, a chat agent for authoring entries.

As you roleplay, the writing AI calls `search` to look up vault entries it needs, and calls `flag` when it reaches for a detail your vault doesn't cover. Each `flag` becomes a record in the Librarian inbox. You open a flag and chat with Emma. She fetches existing entries via tool calls, compares against `lorebook-guide` style references, and helps you author the new entry. Write-to-vault saves the draft as an Obsidian file.

`lorebook-guide` entries are Librarian-only. They never reach the writing AI through any path.

## How the pipeline works

Here is the mental model for what runs every time you (or the AI) sends a message:

```
You send a message
        |
        v
  [1] Build scan text
      DLE concatenates the last N messages (your scan depth)
      into a block of text to search.
        |
        v
  [2] Keyword and BM25 match
      Every entry's keys are checked against the scan text.
      Keyword hits and BM25 fuzzy matches collected as candidates.
      Constants (always-on entries via lorebook-always) included automatically.
        |
        v
  [3] Hierarchical pre-filter (40+ entries only)
      Cluster candidates by category, AI picks categories first.
      Keeps the AI search manifest small on big vaults.
        |
        v
  [4] AI search (optional, two-stage and AI-only modes)
      A compact manifest of the candidates plus recent chat
      goes to your AI search model. The model picks the
      contextually relevant entries.
        |
        v
  [5] Gating
      Per-chat pin and block overrides applied. Contextual gating
      checks era / location / scene / character / custom fields.
      Requires and excludes rules evaluated. Cooldowns enforced.
      Already-injected entries deduped against recent context.
        |
        v
  [6] Budget and formatting
      Entries sorted by priority. Token budget and max-entries caps
      applied. Entries formatted and grouped by injection position.
        |
        v
  [7] Injection
      Formatted entries injected into the prompt at their assigned
      positions (before / after / in_chat at depth N).
        |
        v
  [8] Generate
      The writing AI generates a response with your lore in context.
      If the Librarian is on, it can call search and flag tools
      while generating.
```

Stages 2 and 4 are the **two-stage** pipeline. Two other modes exist: **AI-only** sends the entire vault summary to the AI without keyword pre-filtering (more accurate on small vaults, much more expensive on large ones), and **keywords-only** disables AI search entirely (free, but loses the contextual matches).

The point is that **you do not think about any of this while writing**. You write your story; DLE handles injection in the background. The diagnostics are there for when you want to understand or tune what is happening.

## Cost

Keywords-only mode: free.

Two-stage mode: roughly one extra provider call per turn for AI search. Fraction of a cent per message on Haiku-class models; more on Sonnet or Opus. Local providers (Ooba, KoboldCpp, llama.cpp) work for AI search; expect 60-120s on a long chat where cloud APIs respond in under 10s.

The Librarian: 1-3 tool-call rounds per generation when the writing AI calls `search` or `flag`. Emma's chat sessions are interactive, so cost depends on how much you talk to her. Tool-calling provider required (Claude, Gemini, OpenAI-compat, Cohere).

Each feature has its own connection channel. Run free local inference for retrieval and pay only for Emma, or vice versa.

## Who DeepLore is for

DLE is built for writers who:

- Have a developed fictional world with characters, locations, factions, and lore the AI needs to respect.
- Already use Obsidian or want to.
- Want more control over when and how lore fires than World Info gives them.
- Are willing to spend a few minutes setting up an Obsidian vault and writing entries with YAML frontmatter.

If you have a handful of simple entries and World Info covers it, you do not need DLE. If you have a sprawling vault with dozens or hundreds of entries and want the AI to be selective about which ones matter right now, DLE is built for that.

## Next

- [[Quick Start]] for the 5-minute setup
- [[Writing Vault Entries]] for entry frontmatter
- [[Features]] for the full feature catalog
- [[Pipeline]] for the technical retrieval-flow reference
