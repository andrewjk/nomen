---
nomen-lang: patch
---

Trait-typed local copies of value-struct slots now build on C (concrete-struct declaration); class-backed trait-slot copies and value-struct stores into class-backed slots are check-time rejections; borrow-slot reassignment no longer destroys the shared instance on C
