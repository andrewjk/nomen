---
nomen-lang: patch
---

Box transfer ownership: Box<T>(move x) drops donor string records (shallow copy takes ownership); generated Box destroy reclaims string-only pointees — fixes guarded .at() short-circuit reads through boxed elements
