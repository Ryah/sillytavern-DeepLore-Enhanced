---
graph: false
title: Inline Array Keys Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys: [inline key one, "quoted inline key", 'single-quoted key', plain-key]
summary: "Entry with keys in inline YAML array format (bracket notation). Tests that the parser handles both list and inline array forms."
---

# Inline Array Keys Entry

This entry specifies its `keys` using the YAML inline array syntax: `keys: [key1, "key2", 'key3']`. The `parseFrontmatter` function must parse both the standard list format (with `-` bullets) and this bracket notation correctly.
