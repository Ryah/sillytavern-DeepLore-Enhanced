---
graph: false
title: Probability Zero Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - probability zero test
probability: 0
summary: "Entry with probability set to 0. This entry will never trigger. Should trigger health check WARNING."
---

# Probability Zero Entry

This entry has `probability: 0`, which means it will never be injected even when its keywords match. The health check should warn that this entry can never trigger.
