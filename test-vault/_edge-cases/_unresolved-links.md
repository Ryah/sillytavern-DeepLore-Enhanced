---
graph: false
title: Unresolved Links Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - unresolved links test
summary: "Entry with wiki-links that point to non-existent entries. Should trigger INFO: unresolved wiki-link."
---

# Unresolved Links Entry

This entry contains wiki-links that do not resolve to any entry in the vault. For example, [[Nonexistent Link Target]] and [[Another Missing Entry]] are references to entries that do not exist. The health check should report these as informational warnings about unresolved links.

Unlike errors, unresolved wiki-links are flagged at the INFO level because they may simply indicate entries that have not yet been written, rather than a configuration mistake.
