---
graph: false
title: Number Summary Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - number summary test
summary: 42
---

# Number Summary Entry

This entry has `summary: 42` — a bare integer where a string is expected. The parser should coerce this to the string "42" rather than crashing with a type error. This tests defensive handling of malformed YAML values in the summary field.
