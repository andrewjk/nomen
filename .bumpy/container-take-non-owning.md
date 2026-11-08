---
nomen-lang: patch
nomen: patch
---

Fix containers zeroing non-owning value-struct arguments — `List.push`, `Buffer`, `Arena`, `Set`, `Map` and `LinkedList` now copy handle-like elements (a legal bare argument to a `mv` parameter) instead of taking and zeroing the caller's copy (`T_TAKES_OWNERSHIP`).
