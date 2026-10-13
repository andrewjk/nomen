---
nomen-lang: patch
---

Assigning to a ref alias re-points the alias itself: the assignment is adopted into the alias's own slot (an owning var, freed at scope exit) and the previously-aliased instance stays owned by its owner
