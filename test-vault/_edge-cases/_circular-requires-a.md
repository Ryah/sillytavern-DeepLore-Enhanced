---
graph: false
title: Circular Requires A
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - circular test alpha
requires:
  - Circular Requires B
summary: "Part A of a circular requires pair. Requires B, which requires A back. Should trigger ERROR."
---

# Circular Requires A

This entry requires [[Circular Requires B]], which in turn requires this entry, forming a circular dependency. The health check should detect and flag this as an error.
