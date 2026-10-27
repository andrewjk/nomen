---
nomen-lang: minor
nomen: minor
---

In-place construction for container pushes (GOOSE.md #4): items.push(parse(x)) constructs the call result directly into the new slot in both backends — List.reserve split out of push, checker-stamped single-use argument, sret-into-slot lowering; no _param_N temp, no slot copy, no temp free.
