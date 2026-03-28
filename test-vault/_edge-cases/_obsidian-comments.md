---
graph: false
title: Obsidian Comments Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - obsidian comments test
summary: "Entry with Obsidian comment syntax. Comments should be stripped by cleanContent before injection."
---

# Obsidian Comments Entry

This paragraph is visible content that should be injected.

%%This is an inline Obsidian comment. It should be stripped from the injected content.%%

This paragraph is also visible and should appear in the injected content.

%%
This is a multiline Obsidian comment.
It spans several lines.
All of this content should be stripped.
%%

Final paragraph that should appear in the injected content. The `cleanContent` function in `core/utils.js` strips all `%%...%%` blocks before injection.
