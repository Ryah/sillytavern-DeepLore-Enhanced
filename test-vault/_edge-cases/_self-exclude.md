---
graph: false
title: Self Exclude Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - self exclude test
excludes:
  - Self Exclude Entry
summary: "This entry excludes itself by title. Should trigger health check ERROR: excludes itself."
---

# Self Exclude Entry

This entry lists its own title in the excludes field. The health check should detect that an entry cannot exclude itself and flag this as an error.
