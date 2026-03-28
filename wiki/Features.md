# Features

DeepLore Enhanced has a lot of features. This page is a quick catalog with links to the detail pages where each feature is fully explained.

For the core matching pipeline, see [[Pipeline]]. For AI Search specifics, see [[AI Search]].

---

## Live Drawer Panel

A persistent side panel showing real-time pipeline feedback. See [[Drawer]] for full details.

| Feature | What it does |
|---------|-------------|
| **Why? Tab** | Shows which entries were injected and why, with generation-to-generation diff |
| **Browse Tab** | Searchable, filterable entry list with temperature heatmap, pin/block controls, and virtual scroll |
| **Gating Tab** | View and edit contextual gating filters (built-in and custom fields) with live impact counts and Manage Fields button |
| **Tools Tab** | Quick-access buttons for all slash commands |
| **Status Zone** | Connection status, token/entry budget bars, active gating filters, quick actions |
| **Footer** | Context window bar, health indicators, AI session statistics |

---

## Inspection & Diagnostics

Tools for understanding what DLE is doing and why. See [[Inspection and Diagnostics]] for full details.

| Feature | What it does |
|---------|-------------|
| **Context Cartographer** | Book icon on each AI message showing which entries were injected and why |
| **Pipeline Inspector** | Detailed trace of the last generation (`/dle-inspect`) |
| **Entry Browser** | Searchable popup of all indexed entries (`/dle-browse`) |
| **Relationship Graph** | Interactive force-directed graph of entry connections (`/dle-graph`) |
| **Activation Simulation** | Replay chat history showing entry activation timeline (`/dle-simulate`) |
| **"Why Not?" Diagnostics** | Click any unmatched entry to see exactly why it was not injected |
| **Entry Analytics** | Track match/injection counts per entry (`/dle-analytics`) |
| **Entry Health Check** | 30+ automated checks for common entry issues (`/dle-health`) |

---

## AI-Powered Tools

Features that use AI to help you build and maintain your vault. See [[AI-Powered Tools]] for full details.

| Feature | What it does |
|---------|-------------|
| **Session Scribe** | Auto-summarize sessions and write notes to Obsidian |
| **Auto Lorebook** | AI suggests new entries based on chat content |
| **Optimize Keys** | AI analyzes an entry and suggests better keywords |
| **Auto-Summary** | Generate AI summaries for entries missing a `summary` field |
| **Scribe-Informed Retrieval** | Feed Scribe summaries into AI search for broader story awareness |

---

## Entry Matching & Behavior

Per-entry frontmatter fields and global settings that control when entries trigger. See [[Entry Matching and Behavior]] for full details.

| Feature | What it does |
|---------|-------------|
| **Cooldown** | Skip an entry for N generations after it triggers |
| **Warmup** | Require N keyword occurrences before first trigger |
| **Re-injection Cooldown** | Global setting to skip re-injecting recent entries |
| **Injection Dedup** | Strip entries already injected in recent generations |
| **Entry Decay & Freshness** | Boost stale entries, penalize over-injected ones |
| **Conditional Gating** | `requires` and `excludes` dependency rules |
| **Refine Keys** | Secondary AND filter on top of primary keywords |
| **Cascade Links** | Unconditionally pull in related entries when one matches |
| **Active Character Boost** | Auto-match the active character's entry |
| **Fuzzy Search (BM25)** | TF-IDF scored fuzzy matching alongside exact keywords |
| **New Chat Bootstrapping** | Seed entries and bootstrap injection for early conversations |

---

## Injection & Context Control

How and where entries are injected, and per-chat overrides. See [[Injection and Context Control]] for full details.

| Feature | What it does |
|---------|-------------|
| **Per-Entry Injection Position** | Override position, depth, and role per entry |
| **Prompt Manager Integration** | Register DLE injections as draggable Prompt Manager entries |
| **Author's Notebook** | Persistent per-chat scratchpad injected every generation |
| **Per-Chat Pin/Block** | Pin entries to always inject or block them, per chat |
| **Contextual Gating** | Filter entries by era, location, scene type, characters, and user-defined custom fields (configurable via rule builder) |
| **Confidence-Gated Budget** | AI over-requests, then prioritizes high-confidence picks |

---

## Infrastructure

Under-the-hood systems that make DLE fast and reliable. See [[Infrastructure]] for full details.

| Feature | What it does |
|---------|-------------|
| **Multi-Vault Support** | Connect multiple Obsidian vaults simultaneously |
| **IndexedDB Persistent Cache** | Instant startup from browser-side cache |
| **Reuse Sync** | Skip re-parsing unchanged entries on refresh |
| **Circuit Breaker** | Exponential backoff on Obsidian connection failures |
| **Prompt Cache Optimization** | Anthropic prompt caching for proxy mode AI calls |
| **Sliding Window AI Cache** | Reuse AI results when chat changes are lore-irrelevant |
| **Hierarchical Manifest Clustering** | Two-call AI approach for large vaults (40+ entries) |

---

## Setup & Import

Getting started and migrating from other lorebook systems. See [[Setup and Import]] for full details.

| Feature | What it does |
|---------|-------------|
| **Setup Wizard** | Guided first-time setup (`/dle-setup`) |
| **Quick Actions Bar** | One-click toolbar in the settings panel |
| **ST Lorebook Import** | Convert SillyTavern World Info JSON to Obsidian vault notes |
