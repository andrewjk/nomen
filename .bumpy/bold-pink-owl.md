---
nomen-lang: patch
nomen: patch
---

view-keyword fields (view T name) on plain structs are accepted: the Copyable verifier now honors the view keyword before the mv demand — a view member is a (ptr, len) borrow, never an owner
