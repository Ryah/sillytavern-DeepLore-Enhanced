---
title: BOM Prefix Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - bom prefix test
summary: "Entry with UTF-8 BOM at start of file. The parser should strip the BOM before parsing frontmatter."
graph: false
---

# BOM Prefix Entry

This file begins with a UTF-8 Byte Order Mark (BOM, U+FEFF). The `parseFrontmatter` function in `core/utils.js` strips BOM characters before attempting to parse YAML frontmatter. If the BOM is not stripped, the `---` fence will not be recognized and the entire file will be treated as having no frontmatter.
