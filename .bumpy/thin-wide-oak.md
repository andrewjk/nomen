---
nomen-lang: patch
---

Phase B tranche 4: owning structs own class-typed fields (var spelling, transfer-on-store, displaced reclaim, destroy on both backends), the field restrictions collapse into the Copyable verifier, and the nullable lowerings are pinned (Box<T>? null pointer, inline companion flag, nullable owning-struct return normalization)
