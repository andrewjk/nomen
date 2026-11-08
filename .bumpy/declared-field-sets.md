---
nomen-lang: minor
nomen: minor
---

Feat: declared field sets on ref params — `ref x { fields }` declares the fields a `ref` parameter may displace, enabling field-scoped borrow invalidation. Bodies are verified against the set, trait conformers must narrow it, and editor quick fixes add or extend it. Lints name the fields an un-annotated ref displaces, suggest `{}` for refs that displace nothing (so calls keep callers' borrows alive), suggest taking copyable non-mutating refs by value, and suggest bare `self` for un-mutated `ref self` receivers — each with a local quick fix where one exists. Trait method declarations carry the contract, and the library starts declaring its own effects (`StringBuilder`'s mutators are `{}` — scalar-only state).
