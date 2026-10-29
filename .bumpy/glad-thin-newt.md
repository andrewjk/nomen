---
nomen-lang: patch
nomen: patch
---

Mark the slot-borrow primitives internal (Map.get_ptr, List/Buffer/StableList/ClassBuffer.slot_ptr) - user code reaches them only via the element-borrow rewrite
