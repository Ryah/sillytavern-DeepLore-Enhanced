---
graph: false
title: Depth Without Inchat Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - depth without inchat test
position: before
depth: 4
summary: "Entry with position: before and a depth override. Depth is only meaningful for in_chat position. Should trigger WARNING."
---

# Depth Without Inchat Entry

This entry has `position: before` and `depth: 4`. The `depth` field only applies when `position: in_chat`. With any other position value, the depth override is silently ignored. The health check should warn about this misconfiguration.
