---
nomen-lang: patch
---

Fix: C backend string-ownership sets (string_borrow_vars, moved_string_vars, heap_strings, owned_string_vars, moved) leak across functions like the alias maps did — a borrow-only local name in one function suppressed the scope-exit free of an unrelated owned same-named variable in a later one (leak visible under --audit)
