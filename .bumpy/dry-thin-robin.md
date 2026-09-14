---
nomen-lang: patch
---

Plain func_call resolution must not resolve to a struct/trait method (a method named like a free function, e.g. Arena.free vs the extern free, stole the call)
