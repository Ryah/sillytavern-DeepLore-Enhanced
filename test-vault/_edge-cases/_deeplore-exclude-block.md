---
graph: false
title: DeepLore Exclude Block Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - deeplore exclude test
summary: "Entry with deeplore-exclude blocks. Content inside the blocks should be stripped before injection."
---

# DeepLore Exclude Block Entry

This paragraph appears before the exclude block and should be injected.

%%deeplore-exclude%%
This content is inside a deeplore-exclude block. It contains author notes, DM metadata, or other content that should not be sent to the AI. It should be completely stripped from the injected text.
%%/deeplore-exclude%%

This paragraph appears after the exclude block and should also be injected. The `cleanContent` function handles `%%deeplore-exclude%%...%%/deeplore-exclude%%` blocks with higher priority than regular Obsidian comments.
