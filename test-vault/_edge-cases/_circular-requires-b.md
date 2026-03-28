---
graph: false
title: Circular Requires B
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - circular test beta
requires:
  - Circular Requires A
summary: "Part B of a circular requires pair. Requires A, which requires B back. Should trigger ERROR."
---

# Circular Requires B

This entry requires [[Circular Requires A]], which in turn requires this entry, forming a circular dependency. The health check should detect and flag this as an error.
