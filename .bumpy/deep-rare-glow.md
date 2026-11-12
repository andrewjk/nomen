---
nomen-lang: minor
nomen: minor
---

Nullable chaining grows into a value: chains lower in declaration, assignment, return, and argument positions (flag-writing producer per backend), plus method-call hops (a?.m(args)), call bases (f()?.x) hoisted for single evaluation, and the final-nullable-member hop; spec + ERRORS_PLAN updated
