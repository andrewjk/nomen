---
nomen-lang: patch
---

aarch64 backend: pointer-walk strength reduction — single-access loop addressing becomes post-index walked pointers (`ldr [w], #stride`), killing the index arithmetic from the memory op
