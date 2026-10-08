---
nomen-lang: minor
---

STRUCT_PLAN_3 phase B1 backend cutover: owning structs' string fields are uniformly heap (ctor strdup, owning stores strdup + displaced reclaim, scope-exit destroy frees unconditionally) on both backends; borrow-accessor bindings (.at/.first/.slice/.load/.at_or_panic/.get_or) strdup their copies; method string returns normalize to heap for vtable dispatch; move-base literals and recv carriers follow ownership
