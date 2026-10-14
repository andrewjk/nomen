---
nomen-lang: patch
---

Buffer primitives: mv store_T/modify_T reclaim the displaced slot's owned pointer state (containers/Box/class/closure/enum payloads) behind per-leaf identity guards; specialized alloc per-element destroys and frees the old slab (all element flavors) before the exact-cap calloc
