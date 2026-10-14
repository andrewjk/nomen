---
nomen-lang: patch
---

Buffer primitives: mv store_T reclaims displaced owned state behind per-leaf identity guards; alloc destroys and frees the old slab before the exact-cap calloc (modify_T's container leak re-recorded — a guarded reclaim is unsound there)
