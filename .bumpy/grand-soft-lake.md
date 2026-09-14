---
nomen-lang: patch
---

base-seeded literals: scalar override values are evaluated into temporaries before the base copy/init, so an override reading the destination sees the pre-assignment value
