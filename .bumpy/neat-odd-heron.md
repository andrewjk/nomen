---
nomen-lang: patch
nomen: patch
---

Fix: int64 constant folding beyond 2^53 — the aarch64 literal-op fold now runs on BigInt and wraps like the machine
