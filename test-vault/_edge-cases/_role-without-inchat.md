---
graph: false
title: Role Without Inchat Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - role without inchat test
position: after
role: user
summary: "Entry with position: after and a role override. Role only applies to in_chat position. Should trigger WARNING."
---

# Role Without Inchat Entry

This entry has `position: after` and `role: user`. The `role` field only applies when `position: in_chat`. With any other position value, the role override is ignored. The health check should warn about this misconfiguration.
