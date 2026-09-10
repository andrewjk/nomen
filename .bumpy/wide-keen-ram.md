---
nomen-lang: patch
---

Fix: owned-string expression temps never freed on aarch64 — string comparisons (==/!=) now spill-and-free owned heap-temp operands (the result-type gate missed bool-yielding comparisons), grouped operands like ("a" + "b") + "c" classify as owned temps, nested-in-function callees resolve through their emission label, and the C backend's spill-and-free path no longer drops the != inversion
