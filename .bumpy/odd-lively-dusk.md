---
nomen-lang: minor
nomen: minor
---

Feat: move-on-last-use for structs — a synthesized .copy() whose donor is provably dead rewrites to mv on both backends; the per-field deep copies (strdup per string field, fresh container per List field) and the donor teardown disappear (shape micro-bench, 2M iters: C -20%, aarch64 -29%)
