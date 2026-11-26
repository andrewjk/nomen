---
nomen-lang: minor
nomen: minor
---

!Feat: nullable call results must be null-checked before use
BREAKING: a binding initialized from a call returning T? (or a ?. chain) may be null; reading it unchecked is now a compile error. Test it with != null, or read it through ?? or ?.
