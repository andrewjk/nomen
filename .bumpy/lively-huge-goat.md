---
nomen-lang: minor
nomen: minor
---

Enum payload in-place construction (PERF_PLAN 7): Result.ok(f(x)) constructs the payload straight into the payload slot — C Enum_case_init_take claims the produced buffer, aarch64 stores the raw pair or presets sret to the payload address; checker-stamped direct calls only, whole-site for string payloads
