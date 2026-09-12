---
nomen-lang: patch
---

aarch64 backend: stack-staging elision — push/pop staging pairs around computed indexes become direct register reads (mov-form rename verdict-gated on exact liveness; bare pairs deleted as identities)
