---
graph: false
title: No Keywords Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
summary: "Entry with no keys field at all. Should trigger health check WARNING: no trigger keywords."
---

# No Keywords Entry

This entry has no `keys` field in its frontmatter. It cannot be matched by keyword search. The health check should warn that this non-constant, non-bootstrap entry has no trigger keywords and will never be selected.
