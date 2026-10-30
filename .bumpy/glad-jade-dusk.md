---
nomen-lang: minor
nomen: minor
---

Fix: declaring Map<K, UserStruct> no longer poisons UserStruct(...) ctor calls - the mv-destructure swap synthesizes zero-value constructor arguments, so struct-valued Maps work in-source on both backends
