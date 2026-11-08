---
nomen-lang: minor
nomen: minor
---

Feat: declared field sets on ref params — `ref x { fields }` declares the fields a `ref` parameter may displace, enabling field-scoped borrow invalidation. Bodies are verified against the set, trait conformers must narrow it, and editor quick fixes add or extend it. Lints flag wildcard ref params that displace heap fields, and `{}` refs that are never written through.
