---
graph: false
title: Cooldown On Constant Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
  - lorebook-always
keys:
  - cooldown constant test
cooldown: 3
summary: "Constant entry with a cooldown set. The cooldown has no effect on constants. Should trigger WARNING."
---

# Cooldown On Constant Entry

This entry is tagged `lorebook-always` (constant) but also has `cooldown: 3`. Since constant entries are always injected regardless of cooldown state, the cooldown field has no effect here. The health check should warn about this inconsistency.
