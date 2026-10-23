---
nomen-lang: patch
---

aarch64: use_c raw blocks nested in control flow are now a check + build error (were silently dropped from the companion); mixed use_c/Nomen bodies already errored, nested ones escaped the top-level scan
