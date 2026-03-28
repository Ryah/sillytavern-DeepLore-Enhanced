---
graph: false
title: Duplicate Title Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - duplicate title test beta
summary: "Second of two entries sharing the same title. Should trigger health check ERROR: duplicate entry title."
---

# Duplicate Title Entry

This is the second entry with the title "Duplicate Title Entry". Because `_duplicate-title-a.md` shares this exact title, the health check should flag both as errors. Duplicate titles break requires/excludes resolution and other title-based lookups.
