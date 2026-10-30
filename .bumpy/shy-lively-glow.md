---
nomen-lang: patch
nomen: patch
---

Fix: for ref-of-strings item reassignment transfers the owned pair into the slot (was leaking one allocation per reassigned iteration)
