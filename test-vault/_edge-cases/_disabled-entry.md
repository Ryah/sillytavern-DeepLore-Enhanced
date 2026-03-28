---
graph: false
title: Disabled Entry
type: lore
priority: 50
enabled: false
tags:
  - lore
  - lorebook
keys:
  - disabled entry test
  - should never appear
summary: "This entry is disabled. It should never appear in the vault index."
---

# Disabled Entry

This entry has `enabled: false` in its frontmatter. The vault indexer should skip it entirely. It should never appear in any matching results, health checks, or the graph.
