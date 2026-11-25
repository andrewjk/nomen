---
nomen-lang: minor
nomen: minor
---

!Fix: retire the ufloat family — use float
BREAKING: the `ufloat`, `ufloat32`, and `ufloat64` types no longer exist — they enforced nothing beyond their literals (a `ufloat` happily held `2.0 - 4.0` = `-2.0`). Use the signed `float` family; declarations get a named retirement diagnostic and recover
