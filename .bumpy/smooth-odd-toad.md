---
nomen-lang: patch
---

Fix: C backend alias-own flags leak across functions (undeclared _alias_owns_X compile error when a later function reuses a variable name that a borrow was bound to in an earlier one)
