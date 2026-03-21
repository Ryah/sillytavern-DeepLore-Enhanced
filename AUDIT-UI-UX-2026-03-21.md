# DeepLore Enhanced -- 8-Expert UI/UX Code Audit

**Date:** 2026-03-21
**Target:** DeepLore Enhanced v0.2.0-BETA
**Method:** 8 independent expert agents, each doing two blind passes (exploration + deep analysis)
**Scope:** UI/UX only -- user-facing strings, code comments, documentation, CSS, accessibility, status communication, information architecture, visual hierarchy

---

## Grade Summary

| # | Expert | Paradigm | Grade | One-Line Verdict |
|---|--------|----------|-------|------------------|
| 1 | Kinneret Yifrah | UX Microcopy | **B-** | Diagnostics are A+, toast layer is C-; the gap between best and worst microcopy is unusually wide |
| 2 | Robert C. Martin | Code Comments | **B+** | Outstanding architectural docs; UI modules under-commented; bug-journal comments need rewriting |
| 3 | Daniele Procida | Documentation (Diataxis) | **B-** | Strong reference, good tutorials; monolithic Features.md, zero screenshots, missing conceptual docs |
| 4 | Adam Wathan | CSS Architecture | **C+** | Settings CSS is clean; 95% of popup styling is inline JS with 80+ hardcoded hex colors; confirmed bug |
| 5 | Leonie Watson | Accessibility (WCAG) | **Partial A** | Infrastructure is above-average (ARIA live region, sr-only, reduced-motion); keyboard blocks on advanced toggles and popups |
| 6 | ER Triage Nurse | Status/Error Communication | **B-** | Excellent error engineering internally; user sees almost none of it; AI circuit breaker is invisible |
| 7 | Casino Floor Designer | Information Architecture | **B+** | Feature set is Bellagio-grade on a Holiday Inn floor plan; Context Cartographer is hidden treasure |
| 8 | Jennifer Tipton | Visual Hierarchy (Theatrical) | **B-/D+** | B- engineering, D+ design; a virtuoso playing in a gymnasium |

---

## Confirmed Bugs

### BUG: `--dle-error` and `--dle-warning` resolve to the same color (CSS Expert)

```css
--dle-error: var(--warning, #f44336);
--dle-warning: var(--warning, #ff9800);
```

Both map through `var(--warning)`. When SillyTavern defines `--warning` (which it always does via SmartTheme), both resolve to the **same color**. Errors and warnings are visually identical in production.

**Fix:** Map `--dle-error` through a different ST variable or hardcode it:
```css
--dle-error: var(--SmartThemeFatalColor, #f44336);
--dle-warning: var(--warning, #ff9800);
```

### BUG: `/dle-help` table lies about two commands (Documentation Expert)

1. `/dle-review` described as "AI reviews recent pipeline results" -- actually sends the **entire vault** to AI (commands.js:1444)
2. `/dle-summarize <name>` implies single-entry targeting -- actually takes **zero arguments** and batch-processes all entries missing summaries

### BUG: Writing-Vault-Entries.md warmup description is factually wrong (Documentation Expert)

Says "The keyword must appear in at least 2 separate messages" -- code counts **total occurrences in scan text**, not separate messages. One message with 3 mentions satisfies `warmup: 3`.

---

## Cross-Expert Consensus (themes that appeared in 3+ reports)

### 1. Context Cartographer is the crown jewel but it's hidden (Experts 1, 6, 7, 8)

The Context Cartographer popup (diff display, token gradient bars, keyword highlighting, grouped-by-position layout, Obsidian deep links) is unanimously identified as the best-designed UI surface. But `showLoreSources` defaults to `false`, so most users never see it.

**Consensus recommendation:** Default `showLoreSources` to `true`. One-line change in settings.js. Highest ROI change available.

### 2. The system works invisibly -- no generation feedback loop (Experts 6, 7, 8)

When DLE injects lore, there is zero visible indication unless Context Cartographer is enabled. Users can chat for 30 minutes with a dead vault connection and see nothing wrong.

**Consensus recommendation:** Dynamic header badge showing last injection summary: "5 entries injected (~1,200 tok)". Persistent status dot: green/yellow/red for system health.

### 3. Inline styles epidemic (Experts 4, 7, 8)

161 lines of CSS vs ~195 inline `style=` attributes across JS files. The same bordered-card pattern is reconstructed with slight variations (border-radius: 2px/4px/5px; margin-bottom: 2px/4px/6px/8px/10px) across 8+ popup builders. 80+ hardcoded hex colors that don't respond to themes.

**Root cause:** CSS custom properties are scoped to `.deeplore_enhanced_settings` (settings panel root), but popups render via `callGenericPopup` as direct children of `<body>` -- outside the CSS variable scope.

**Consensus recommendation:** Move `--dle-*` custom properties to `:root`. Create ~15 popup component classes (`.dle-card`, `.dle-card-header`, `.dle-preview`, `.dle-badge`, etc.). Migrate inline styles file-by-file. Estimated: 5-6 hours.

### 4. Settings panel needs visual zones (Experts 7, 8)

16 sections at identical visual weight. "Vault Connections" (critical first-time setup) looks the same as "Entry Decay" (expert tuning 5% of users touch). Three nesting patterns (sections, drawers, Show Advanced) with no visual distinction.

**Consensus recommendation:** Three-tier visual hierarchy (Spotlight/Key Light/Ambient). CSS-only change: modulate margin-top, font-size, and opacity per tier class.

### 5. "Check console for details" is a dead end (Experts 1, 6)

The highest-stakes error in the extension ("Lore injection failed") gives the lowest-quality guidance. The error classification pattern from `vault.js:300-312` already exists and works well but isn't applied to the pipeline failure path.

**Consensus recommendation:** Extract the error classifier from vault.js into a shared utility. Apply it to `index.js:369` and all 6+ raw `Error: ${err.message}` sites.

### 6. AI circuit breaker is invisible (Experts 6, 7)

When the AI circuit breaker trips (2 failures = 30s cooldown), it silently suppresses all AI search. The pipeline falls back to keyword matching with one 6-second toast. No persistent "AI paused" indicator anywhere.

**Consensus recommendation:** When `isAiCircuitOpen()` returns true, show a persistent indicator in the AI stats line and shift the header badge to yellow.

---

# EXPERT REPORT 1: UX Microcopy
## Kinneret Yifrah -- Grade: B-

### Best Microcopy in the Extension

The `diagnoseEntry()` function in diagnostics.js. It walks through 11 pipeline stages, finds the FIRST one that blocked an entry, and returns a human-readable explanation with a specific suggestion using the user's actual data:

> Keyword "war" appears in older messages. Increase scan depth from 4 to reach it.

### Worst Microcopy in the Extension

`index.js:369`: "Lore injection failed -- check console for details."

This fires when the entire pipeline throws an uncaught exception. The highest-stakes error gives the lowest-quality guidance.

### Voice Assessment

The extension has a split personality. The diagnostic system speaks with careful authority. The toast messages speak like a chatbot having a panic attack. Recommended voice: "Confident technician" -- never apologize, always give the next step, reserve exclamation marks for setup wizard completion only.

### Severity Misclassifications Found

- `toastr.warning` used for usage hints ("Usage: /dle-pin <entry name>") -- should be `info` (6+ locations)
- `toastr.warning` used for preconditions ("No active chat.", "Enable DeepLore Enhanced first.") -- should be `info` (8+ locations)
- `toastr.info` used for cost warning ("Running pipeline with live AI search -- this uses API tokens.") -- should be `warning`

### Priority Fixes

| # | Fix | Sites | Impact |
|---|-----|-------|--------|
| P0 | Extract shared `classifyError()` utility from vault.js pattern | 6+ | Eliminates raw error passthrough |
| P0 | Replace "check console" in index.js:369 | 1 | Highest-traffic error |
| P0 | Centralize "No entries indexed" constant with next step | 8+ | Consistent guidance |
| P1 | Fix severity misclassifications | 15+ | Correct signal hierarchy |
| P1 | Consolidate duplicate profile-not-found messages (ai.js:57-60) | 2 | Consistency |
| P1 | Humanize SSRF errors in proxy-api.js | 3 | Users see "blocked (SSRF)" for localhost typos |
| P2 | Spell out "pri" to "Priority" in cartographer.js:153 | 1 | Clarity |
| P2 | Add navigation hint to budget warning (index.js:339) | 1 | Actionable |
| P2 | Standardize helpString format across 24+ slash commands | 24+ | Consistency |
| P2 | Rewrite BM25/TF-IDF tooltip in plain language | 1 | Accessibility |

---

# EXPERT REPORT 2: Code Comments
## Robert C. Martin ("Uncle Bob") -- Grade: B+

### Three Best-Commented Sections

1. **state.js** -- Masterclass in state documentation. Every variable has scoped JSDoc. Observer pattern motivation explained. Setter rationale (ES module constraints) documented.
2. **stages.js** -- Complete JSDoc, design philosophy in header, exemption policy as self-documenting architecture. Stage numbering with section dividers creates a visual pipeline matching the mental model.
3. **obsidian-api.js circuit breaker** -- Explains the problem, the design (per-port keying), HTTP status code categorization rationale.

### Three Worst-Commented Sections

1. **cartographer.js showSourcesPopup()** -- 135-line HTML construction with one JSDoc line and opaque spec references (7.1, 7.4, 7.14).
2. **popups.js** -- Functional comments that miss the "why" throughout.
3. **auto-suggest.js** -- Module header is a bug fix journal ("Fixes Bug 1 and Bug 3").

### Key Archaeological Insight

The comments reveal a solo developer at high velocity with periodic expert review. The letter-number references (C4, H9, M13) are audit item codes. The BUG FIX comments are urgent fixes from that audit. The codebase is mid-quality-arc -- the fixes were applied with urgency rather than being fully integrated into the permanent narrative.

### Priority Fixes (~2 hours total)

| # | Fix | Time | Impact |
|---|-----|------|--------|
| 1 | Rewrite 6 BUG FIX comments as behavioral descriptions | 30 min | Removes temporal noise |
| 2 | Expand or remove ~10 opaque audit references | 20 min | Removes context-dependent opacity |
| 3 | Add structural comments to 3 under-documented UI functions | 45 min | Biggest readability gain |
| 4 | Document the sliding window cache invariant in ai.js | 10 min | Protects algorithmic intent |
| 5 | Clean ~5 re-export migration breadcrumbs | 15 min | Removes migration artifacts |
| 6 | Document parseFrontmatter design decision | 5 min | Prevents "why not use a library?" questions |

---

# EXPERT REPORT 3: Documentation
## Daniele Procida (Diataxis) -- Grade: B-

### Grade Breakdown

- Reference documentation: **A** (Settings-Reference, Slash-Commands, Glossary, Writing-Vault-Entries)
- Tutorial documentation: **B+** (Quick-Start, First-Steps, Installation)
- How-to guides: **B-** (scattered across Features.md)
- Conceptual/explanation: **D** (almost entirely missing)
- Visual documentation: **F** (zero screenshots, `wiki/images/` is empty)
- Accuracy: **B-** (two confirmed /dle-help errors, one warmup description error)

### Confirmed Factual Errors (P0)

1. `/dle-help` says `/dle-review` = "AI reviews recent pipeline results" -- actually sends entire vault
2. `/dle-help` shows `/dle-summarize <name>` -- takes zero arguments, batch-only
3. Writing-Vault-Entries.md warmup: "appear in at least 2 separate messages" -- counts total occurrences, not messages

### Fully Undocumented Features

1. **Fuzzy Search (BM25/TF-IDF)** -- settings toggle exists, no Features.md section
2. **"Why Not?" Diagnostics** -- mentioned in README, zero wiki documentation
3. **Test Match button** -- one-line mention in Settings-Reference, no explanation
4. **Budget-Aware Entry Truncation** -- in CHANGELOG, not in Features.md
5. **Generation lock/epoch system** -- only mentioned as "can get stuck" in Troubleshooting

### Features.md Decomposition Recommendation

Move tool descriptions to Slash-Commands.md (already duplicated). Move entry behavior specs to Writing-Vault-Entries.md. Move infrastructure explanations to Pipeline.md. Leave Features.md as a ~100-line linked catalog.

### Proposed Wiki Sidebar Reorganization

```
Getting Started
  - What is DeepLore? (NEW)
  - Installation
  - Quick Start
  - First Steps

Using DeepLore
  - Writing Vault Entries
  - AI Search
  - AI-Powered Features (NEW: Scribe, Auto Lorebook, Auto-Summary)
  - Diagnostics & Debugging (NEW: Health, Inspector, Why Not?, Simulation)

Reference
  - Pipeline
  - Features (catalog)
  - Settings Reference
  - Slash Commands
  - Glossary

Help
  - Troubleshooting
  - Migration Guide (NEW)
```

---

# EXPERT REPORT 4: CSS Architecture
## Adam Wathan -- Grade: C+

### Grade Breakdown

| Category | Grade |
|----------|-------|
| Settings panel CSS | A- |
| Theme integration (settings) | B- |
| Theme integration (popups) | F |
| Popup styling | D |
| Architecture | D+ |
| Naming conventions | B |
| Accessibility CSS | A- |
| Color system | D |
| DRY principle | D |

### The Root Cause

CSS custom properties defined on `.deeplore_enhanced_settings` (settings panel root). Popups via `callGenericPopup` render outside that DOM tree as direct children of `<body>`. So `--dle-*` variables don't reach popups. This is why popup code hardcodes hex values.

**One-line fix:** Move `--dle-*` definitions from `.deeplore_enhanced_settings` to `:root`.

### Inline Style Pattern Catalog (195 total)

| Pattern | Description | Occurrences |
|---------|-------------|-------------|
| A | Card container (border, radius, padding, margin) | ~25 |
| B | Flex header row (justify, align, cursor) | ~15 |
| C | Content preview (pre-wrap, max-height, overflow, bg) | ~12 |
| D | Muted small text (opacity, font-size) | ~30+ |
| E | Status badge (color, size, weight) | ~10 |
| F | Token bar (bg, radius, height) | ~3 |
| G | Monospace popup root (align, font-family) | ~5 |
| H | Table styling (width, collapse, borders) | ~3 |

### Proposed Component Classes

```css
.dle-card { border: 1px solid var(--dle-border); border-radius: 4px; padding: 8px; margin-bottom: 6px; }
.dle-card-header { display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
.dle-preview { white-space: pre-wrap; font-size: 0.85em; max-height: 300px; overflow-y: auto; background: var(--dle-bg-surface); padding: 8px; border-radius: 4px; }
.dle-muted { opacity: 0.7; }
.dle-success { color: var(--dle-success); }
.dle-error { color: var(--dle-error); }
.dle-warning { color: var(--dle-warning); }
.dle-info { color: var(--dle-info); }
```

### Additional Finding: `stageColors` duplicated 3x

The same `stageColors` object (keyword_miss, warmup, probability, cooldown, etc.) appears identically in `popups.js`, `commands.js`, and `settings-ui.js`. Should be a single exported constant.

### Migration Path (5-6 hours)

1. Move CSS vars to `:root` + fix error/warning bug (30 min)
2. Add popup component classes to style.css (1 hour)
3. Replace inline styles file-by-file: cartographer.js -> auto-suggest.js -> popups.js -> commands.js -> settings-ui.js (2-3 hours)
4. Consolidate naming: rename 3 `deeplore_enhanced_*` classes to `dle_*` (30 min)
5. Extract `stageColors` + replace `.css('opacity')` with class toggling (30 min)

---

# EXPERT REPORT 5: Accessibility
## Leonie Watson -- Grade: Partial Level A Conformance

### What's Genuinely Good

The extension is **significantly above average** for the SillyTavern ecosystem:
- ARIA live region (`#dle_sr_live`) with `announceToSR()` helper
- `.sr-only` class (modern clip-rect pattern)
- `prefers-reduced-motion` media query
- `focus-visible` outlines (green ring, 2px solid)
- `aria-hidden="true"` on all decorative icons
- `aria-expanded` + `aria-controls` on overflow toggle
- `aria-label` on vault inputs
- Native `<label>` on checkboxes

### Critical Finding: SillyTavern Mitigates C1

SillyTavern's `keyboard.js` globally registers `.menu_button` elements and adds Enter-key activation via `handleGlobalKeyDown`. So DLE's div.menu_button elements DO receive Enter key support. **However:** Space key is NOT handled (only Enter). `role="button"` is still missing from all 19+ buttons.

**Revised C1 severity: High (down from Critical).**

### Remaining Critical Issues

| ID | Issue | Impact |
|----|-------|--------|
| C2 | 5 "Show Advanced" toggles have no tabindex, no role, no keyboard handler. NOT in ST's interactable selectors. **Completely unreachable by keyboard.** | Advanced settings locked for keyboard users |
| C4 | Graph visualization is entirely inaccessible -- canvas-only, mouse-only, no text alternative | Entire Graph feature non-functional for keyboard/screen reader |

### High Issues

| ID | Issue |
|----|-------|
| H1 | Vault checkboxes have no visible/accessible label text |
| H2 | Status indicators rely on color alone (red/green) |
| H3 | Browse popup search/filter inputs lack labels/aria-label |
| H4 | `announceToSR()` used in only 4 places; should cover index refresh, AI test, stats updates |
| H5 | "More actions" ellipsis has no accessible name |
| H6 | Health badge is a clickable span with no role/tabindex |

### 5 Highest-Impact Fixes

1. **Make "Show Advanced" toggles keyboard-accessible** -- add tabindex="0", role="button", keydown handler. Unlocks all advanced settings for keyboard users.
2. **Add `role="button"` to all div.menu_button** -- screen readers announce 20+ controls properly.
3. **Make popup entry toggles keyboard-accessible** -- tabindex, role, keydown on `.dle_ctx_toggle` and `.dle_entry_toggle`.
4. **Add aria-label to Browse popup inputs** -- 4 attribute additions.
5. **Provide text alternative for Graph** -- render node/edge summary as hidden div. Data already computed.

---

# EXPERT REPORT 6: Status & Error Communication
## ER Triage Nurse -- Grade: B-

### RED FLAGS (Critical Gaps)

1. **No persistent health indicator.** Header badge shows entry count only. Nothing about connection health, AI status, or degradation mode. User can chat 30 min with dead Obsidian connection.
2. **AI circuit breaker is invisible.** Silently suppresses AI search. Single 6-second warning toast. No persistent "AI offline" indicator. Only logged in debug mode.
3. **Fallback state is ephemeral.** After AI->keyword fallback, one toast disappears and system looks identical to "working fine."

### Complete Error Escalation Map

| Tier | State | Current Behavior | Gap |
|------|-------|------------------|-----|
| 0 | Normal | Green health badge (if settings open) | No badge when drawer collapsed |
| 1 | Degraded | console.warn for partial vault failure | Invisible to user |
| 2 | Limited | 6s toast for AI fallback | Disappears; system looks normal after |
| 3 | Critical | dedupError toast for total vault failure | Good text but ephemeral |
| 4 | Offline | Extension disabled checkbox | Adequate |

**Fundamental gap:** No state machine. Each component handles errors locally (good for resilience) but nobody aggregates them into system-level health status.

### Proposed Persistent Status Indicator

Collapsed (always visible in drawer header): `(142 entries | [green dot] OK)`

Four states: Green (OK) / Yellow (Degraded) / Orange (Limited) / Red (Offline)

Expanded (when drawer open): Three subsystem lines:
```
Vault:  [green] Primary (12s ago) | [red] Secondary (unreachable since 3:14pm)
AI:     [green] Profile: Claude Haiku (3 calls, 2 cached)
Index:  [green] 142 entries, 847 keys, ~24k tokens | Health: A
```

### Input Validation Gaps Found

- Proxy URL fields: no format validation (missing protocol, garbage strings accepted)
- API key fields: trailing whitespace not stripped
- Tag fields: leading `#` not stripped (Obsidian tags don't include hash)
- Folder paths: no path traversal or illegal character validation
- Injection template: no check for `{{content}}` macro presence

### Priority Fixes

| # | Fix | Impact |
|---|-----|--------|
| STAT-1 | Persistent status badge in header | Always-visible system health |
| STAT-2 | Make AI circuit breaker visible | Eliminate invisible AI suppression |
| STAT-3 | Replace "check console" with classified error | Actionable pipeline failures |
| URG-1 | Show cache age in stale-data warning | Temporal awareness |
| URG-2 | Validate proxy URL format on blur | Catch most common misconfiguration |
| URG-3 | Strip leading # from tag inputs | Prevent zero-entry surprise |
| URG-4 | Add missing pipeline stages to /dle-inspect | Complete trace visibility |

---

# EXPERT REPORT 7: Information Architecture
## Casino Floor Designer -- Grade: B+

### Proposed Zone Architecture

| Zone | Name | Contents | Visual Treatment |
|------|------|----------|-----------------|
| A | "The Lobby" | Enable, Quick Actions, Vault Connections, Vault Tags | Default bg, prominent status, getting-started affordance |
| B | "The Main Floor" | Search Mode, Matching & Budget, Injection, Context Cartographer | Subtle accent, where 80% of tuning happens |
| C | "The High Roller Room" | AI Search, Entry Decay, Session Scribe, Auto Lorebook, Author's Notebook | Distinct border signaling "premium/AI zone" |
| D | "Back of House" | Index & Cache, Advanced, Slash Commands | Muted, collapsed by default |

### Key Structural Moves

- **Move Author's Notebook** from between Cartographer and AI drawers into Zone C (it's an authoring tool, not matching)
- **Move Entry Decay** into Zone C next to AI Search (meaningless without AI enabled)
- **Move Context Cartographer** into Zone B lead position after Injection (it's the matching feedback mechanism)

### Connection Config Repetition (3x)

AI Search, Session Scribe, and Auto Lorebook each independently define: radio group, profile dropdown, proxy URL, model override, max tokens, timeout. Same `updateConnectionVisibility()` abstraction exists in code but not in UI.

**Recommendation:** Reusable "Connection Card" visual component + "Copy from AI Search" convenience button on Scribe/Auto Lorebook cards.

### Quick Actions Audit

**Duplicated:** Refresh, Browse, Test Match all appear in both Quick Actions and Index & Cache section. Kill the Index & Cache buttons.

**Missing:** Status button (the /dle-status command has no button equivalent).

**Promote:** Simulate and Inspect from overflow to primary row for AI Search users.

### The Generation Feedback Gap

The single biggest UX gap. Three proposed tiers:
1. **Always-on:** Dynamic header badge ("5 entries injected (~1,200 tok)")
2. **Opt-in (default on):** Context Cartographer book icon on messages
3. **Power user:** Optional inline injection footer below AI messages

### Matching & Budget Split

Current: 15 controls in one section. "Case sensitive" (benign) grouped with "Re-injection cooldown" (potentially harmful).

**Recommendation:** Split advanced into "Matching Options" (case, whole words, recursive, optimize) and "Suppression Settings" (cooldown, dedup, lookback) with a warning label.

---

# EXPERT REPORT 8: Visual Hierarchy & Transitions
## Jennifer Tipton (Theatrical Lighting) -- Grade: B- engineering, D+ design

*"The pipeline is the performance. The design is the house it performs in. Right now, the audience is watching a virtuoso play in a gymnasium."*

### The Lighting Plot (3-Tier Settings Hierarchy)

| Tier | Treatment | Sections |
|------|-----------|----------|
| Spotlight (Tier 1) | Larger headers, more whitespace, subtle accent | Enable + Quick Actions, Vault Connections, Search Mode |
| Key Light (Tier 2) | Normal weight, standard spacing | Matching & Budget, Injection, Cartographer, Notebook, Index |
| Ambient (Tier 3) | Dimmer headers, tighter spacing, indent | Entry Decay, AI Search, AI-Powered Features, Advanced, Commands |

### Proposed Transition Language

| Action | Element | Duration | Easing |
|--------|---------|----------|--------|
| Toggle Show Advanced | section | 200ms | ease-out |
| Drawer open/close | content | 250ms | ease-in-out |
| Button hover | background | 120ms | ease |
| Entry expand in popup | detail panel | 180ms | ease-out |
| Card accepted (auto-suggest) | border + opacity | 300ms | ease |

**Critical rule:** All transitions must respect `prefers-reduced-motion` (already has the CSS media query).

### Color Semantic Vocabulary

| Color | Variable | One Meaning |
|-------|----------|-------------|
| Green | `--dle-semantic-positive` | Success, health, alive |
| Red | `--dle-semantic-negative` | Error, block, exclusion |
| Amber | `--dle-semantic-caution` | Warning, attention needed |
| Blue | `--dle-semantic-info` | Informational, neutral |
| Purple | `--dle-semantic-ai` | AI involvement |
| Orange | `--dle-semantic-special` | Special behavior (constant, bootstrap) |

**Current problem:** Green (#4caf50) means 8 different things. "Pinned" (positive action = green) and "constant" (special behavior = should be orange) are both green.

### Proposed Type Scale (minor third, 1.2 ratio)

| Token | Size | Use |
|-------|------|-----|
| `--dle-text-xs` | 0.72em | Validation messages |
| `--dle-text-sm` | 0.85em | Descriptions, metadata |
| `--dle-text-base` | 1.0em | Body, labels |
| `--dle-text-lg` | 1.1em | Tier-1 headers |
| `--dle-text-xl` | 1.25em | Popup titles |

### Proposed Spacing Scale (4px base)

| Token | Value | Use |
|-------|-------|-----|
| `--dle-space-1` | 4px | Between badges |
| `--dle-space-2` | 8px | Card padding, control gaps |
| `--dle-space-3` | 12px | Between cards |
| `--dle-space-4` | 16px | Between tier-2 sections |
| `--dle-space-5` | 24px | Between tier-1 sections |

### Proposed Opacity Scale (3 levels, not 4)

| Token | Value | Use |
|-------|-------|-----|
| `--dle-muted` | 0.65 | Secondary text |
| `--dle-faint` | 0.45 | Disabled states |
| `--dle-ghost` | 0.25 | Placeholders |

### Popup Staging (ranked by dramatic worth)

**Full staging (custom layout, data visualization):** Context Cartographer, Graph, Entry Browser

**Designed but modest (apply design system):** Simulation, Health Check, Auto-Suggest, Analytics

**Minimal staging (keep simple):** Notebook, Optimize, Status, Scribe History, Setup Wizard

---

## Unified Priority Matrix

Combining all 8 experts' recommendations into a single priority list:

### P0 -- Do Immediately (bugs + highest-impact one-liners)

1. **Fix `--dle-error`/`--dle-warning` CSS bug** -- errors and warnings same color in production (CSS Expert)
2. **Fix 3 factual errors** in /dle-help and Writing-Vault-Entries.md warmup (Docs Expert)
3. **Default `showLoreSources` to `true`** -- one-line change, unlocks feedback loop for every user (Casino + Triage + Lighting)
4. **Replace "check console for details"** in index.js:369 with classified error (Microcopy + Triage)

### P1 -- Do Soon (high-impact, moderate effort)

5. **Move CSS vars to `:root`** -- unblocks all popup theming (CSS Expert)
6. **Make "Show Advanced" toggles keyboard-accessible** -- unlocks advanced settings for keyboard users (a11y Expert)
7. **Add `role="button"` to all div.menu_button** -- screen readers identify 20+ controls (a11y Expert)
8. **Persistent status badge in header** -- always-visible system health (Triage + Casino)
9. **Make AI circuit breaker visible** -- eliminate invisible AI suppression (Triage)
10. **Extract shared `classifyError()` utility** -- eliminate raw error passthrough in 6+ sites (Microcopy)
11. **Fix toast severity misclassifications** -- warning->info for usage hints, info->warning for cost (Microcopy)
12. **Add popup component CSS classes** -- `.dle-card`, `.dle-preview`, `.dle-badge`, etc. (CSS + Lighting)

### P2 -- Do in Next Release (structural improvements)

13. **Implement zone architecture** with visual separators in settings (Casino + Lighting)
14. **Decompose Features.md** into linked catalog + focused pages (Docs Expert)
15. **Add screenshots** to wiki -- minimum 5 (settings, Cartographer, health, inspect, wizard) (Docs Expert)
16. **Document undocumented features** -- "Why Not?" diagnostics, Fuzzy Search, Test Match (Docs Expert)
17. **Make popup entry toggles keyboard-accessible** (a11y Expert)
18. **Migrate inline styles to CSS classes** file-by-file (CSS + Lighting)
19. **Validate proxy URL and strip # from tags on blur** (Triage)
20. **Rewrite BUG FIX comments as behavioral descriptions** (Comments Expert)
21. **Write "What is DeepLore?" conceptual page** (Docs Expert)

### P3 -- Polish (when touching these files)

22. Connection Card pattern for 3x repeated AI config (Casino)
23. Transition language for expand/collapse and hover (Lighting)
24. Color semantic vocabulary (one color = one meaning) (Lighting)
25. Type scale and spacing scale CSS variables (Lighting)
26. Graph text alternative for screen readers (a11y)
27. Expand /dle-inspect with missing pipeline stages + "what to do" hints (Triage)
28. Standardize slash command helpString format (Microcopy)
29. Consolidate naming: 3 `deeplore_enhanced_*` -> `dle_*` (CSS)
30. Document sliding window cache invariant in ai.js (Comments)
