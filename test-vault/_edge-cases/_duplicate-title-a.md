---
graph: false
title: Duplicate Title Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - duplicate title test alpha
summary: "First of two entries sharing the same title. Should trigger health check ERROR: duplicate entry title."
---

# Duplicate Title Entry

This is the first entry with the title "Duplicate Title Entry". Because another entry (`_duplicate-title-b.md`) shares this exact title, the health check should flag both entries with an error about duplicate titles. The title collision can cause undefined behavior when entries reference each other by title.
