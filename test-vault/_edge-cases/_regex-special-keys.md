---
graph: false
title: Regex Special Keys Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - "fire.*ball"
  - "magic+1"
  - "spell[1]"
  - "hero(ine)"
  - "price $10"
  - "^forbidden^"
  - "path\\to\\ruin"
summary: "Entry with regex special characters in keywords. Tests that the matcher escapes these correctly and does not crash."
---

# Regex Special Keys Entry

This entry has keywords containing regex metacharacters: `.`, `*`, `+`, `[`, `]`, `(`, `)`, `$`, `^`, and `\`. The keyword matching engine must escape these characters before using them in regular expressions, otherwise matching will crash or produce incorrect results.
