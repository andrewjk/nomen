---
nomen-lang: minor
---

STRUCT_PLAN_3 D3 endgame: `string` is a declared owning type — bindings/assignments from another string variable require `move` or `.copy()`, string field reads and `return self.field` require `.copy()`, owning fields reject borrowed stores, `move string` parameters demand `move` at the call site, container stores transfer, and the silent last-use assign copy is retired. Adds the `string.copy()` method; literals remain exempt. String captures in lambdas stay backend snapshots with checker read-invalidation.
