---
nomen-lang: patch
---

fix generic enums with class/trait payloads: mono case payload rides as a struct Tag pointer on C, payload ownership enforced at check time, payload destroy+free at scope exit on both backends
