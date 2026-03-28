---
graph: false
title: Orphaned Requires Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - orphaned requires test
requires:
  - Nonexistent Entry XYZ
summary: "Test entry that requires a non-existent entry. Should trigger health check ERROR."
---

# Orphaned Requires Entry

This entry requires a lore entry called "Nonexistent Entry XYZ" that does not exist in this vault. The health check should flag this as an error.
