---
nomen-lang: minor
nomen: minor
---

!Fix: Array<T> struct fields are owned by an mv struct and freed with it
BREAKING: a plain `struct` can no longer declare an `Array<T>` field — mark it `mv struct`; store fresh arrays or `mv` a local in
