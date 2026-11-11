---
nomen-lang: patch
nomen: patch
---

mark_library_nodes walks every node, so declarations inside closures held by expressions (a lambda in a declaration value or a call argument) stamp as library — the GUI lint no longer false-positives on System code
