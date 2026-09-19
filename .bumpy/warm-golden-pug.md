---
nomen-lang: minor
---

Anonymous functions gain the keyword form inline (func (out int) { ... }, func (x) => x * 2) and the block-without-arrow form parses inline too; passing a func-typed binding as a call argument no longer false-mismatches ('int (expected func)') or resolves to the static descriptor over the local's heap closure
