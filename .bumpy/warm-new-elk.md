---
nomen-lang: patch
---

Plain string assignment now restores value semantics (s = t strdups an owned copy) with move-on-last-use transfer for provably dead sources; fixes cross-scope dangle, return-escape, and ref-mutation aliasing UAFs on both backends
