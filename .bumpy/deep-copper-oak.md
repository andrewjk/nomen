---
nomen-lang: patch
---

move-param leak fix: a method call on a moved class param no longer disables the callee's epilogue reclaim unless the method can retain its receiver
