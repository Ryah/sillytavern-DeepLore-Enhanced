---
graph: false
title: Requires Excludes Contradiction Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - requires excludes contradiction test
requires:
  - Oracles of Might
excludes:
  - Oracles of Might
summary: "Entry that both requires and excludes the same title. Should trigger ERROR: requires AND excludes same entry."
---

# Requires Excludes Contradiction Entry

This entry has `requires: [Oracles of Might]` AND `excludes: [Oracles of Might]`. This is a logical contradiction: the entry requires Oracles of Might to be matched before it can inject, but also excludes itself if Oracles of Might is matched. The entry can never trigger under any conditions. The health check should flag this as an error.
