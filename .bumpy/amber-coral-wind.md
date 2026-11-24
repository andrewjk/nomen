---
nomen-lang: minor
nomen: minor
---

Value-struct ref self receivers derive the empty field set: every field a Copyable can declare is value storage, so wildcard receivers provably displace nothing — they compose with {}-narrowed ref params, the {} lint fires only on mv struct setters, and lifecycle receivers keep the permissive wildcard
