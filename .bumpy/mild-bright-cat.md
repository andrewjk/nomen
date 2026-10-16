---
nomen-lang: patch
---

Fix: per-body variable_types isolation for struct methods/inits (a float param inherited a view-string's type and mis-lowered to_string on both backends)
