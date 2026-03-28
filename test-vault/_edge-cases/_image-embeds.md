---
graph: false
title: Image Embeds Entry
type: lore
priority: 50
tags:
  - lore
  - lorebook
keys:
  - image embeds test
summary: "Entry with Obsidian image embeds and markdown images. Both should be stripped by cleanContent."
---

# Image Embeds Entry

This paragraph contains visible lore text that should be injected.

![[portrait-of-the-archivist.png]]

The image embed above (Obsidian `![[...]]` syntax) should be stripped by `cleanContent`. Here is a standard markdown image that should also be stripped:

![A portrait of the archivist](https://example.com/portrait.jpg)

This final paragraph is visible content. The `cleanContent` function strips both `![[file]]` Obsidian embeds and `![alt](url)` markdown images to prevent raw image syntax from appearing in AI context.
