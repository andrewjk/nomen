---
nomen-lang: patch
---

Reject storing a borrowed class value into an owning (move) class field — the borrowed shape double-freed on both backends; the move-param mutator idiom stays legal
