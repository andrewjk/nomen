---
nomen-lang: patch
nomen: patch
---

Fix symbol tokens carrying the preceding word's source offset — a word-adjacent symbol (e.g. the `)` after `nothing`) was anchored one token behind, shifting symbol-anchored error positions and editor offsets.
