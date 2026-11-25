---
nomen-lang: patch
nomen: patch
---

!Fix: retire T: type — spell type params type T
BREAKING: the reversed `T: type` spelling no longer parses — declare comptime type parameters `type T` (the ordinary `Type name` order); existing declarations get a named retirement diagnostic and recover
