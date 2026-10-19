---
nomen-lang: patch
---

Fix: C-backend trait-boxing referenced the audit-only malloc wrapper, so trait-typed mv parameters failed to compile in non-audit builds
