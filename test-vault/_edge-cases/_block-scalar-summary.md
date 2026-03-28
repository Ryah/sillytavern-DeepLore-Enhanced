---
graph: false
title: Block Scalar Summary Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - block scalar test
summary: |
  This summary uses a YAML literal block scalar (the pipe character).
  It preserves newlines exactly as written.
  The parser must handle this correctly.
---

# Block Scalar Summary Entry

This entry uses a YAML `|` (literal block scalar) for the summary field instead of a quoted string. The `parseFrontmatter` function handles both `|` (literal) and `>` (folded) YAML block scalars. This entry tests that the `|` form parses correctly and the resulting summary string contains the full text.
