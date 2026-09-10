---
nomen-lang: patch
---

Fix: element type of a cross-file generic return resolved order-independently — the mono instantiation is flowed at call time and materialized on demand at member access, so implicit-typed results (const diffs = combined(a, b)) no longer degrade to the bare type param in entry-first merge order
