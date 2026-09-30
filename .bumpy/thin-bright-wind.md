---
nomen-lang: patch
---

C branch builders copy heap_string_fields per branch (in-place record adds leaked into siblings, freeing zero-init field defaults)
