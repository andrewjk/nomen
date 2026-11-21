---
nomen-lang: patch
nomen: patch
---

Perf: BigInt Knuth-D restructure — one product per quotient digit, per-target D4 shape (fused mul-sub on C, two-pass on aarch64/js); edigits 1.56x/1.62x at n=50000, pidigits -6%/-16%; new divrem invariant test
