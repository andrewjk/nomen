---
nomen-lang: minor
nomen: minor
---

!Fix: bitwise ops bind tighter than comparisons (the Go/Rust order)
BREAKING: expressions mixing bitwise ops with comparisons without parentheses change meaning — `flags & mask == mask` now reads as `(flags & mask) == mask`; parenthesize the old grouping (`x == (a | b)`) to keep it
