---
nomen-lang: minor
nomen: minor
---

In-place store for container sets (PERF_PLAN 6): lst.set(i, f(x)) / buf.set / map.set construct the call result straight into the destination slot — Map.set_slot_ptr probe-then-construct primitive, Buffer/ClassBuffer destroy_at displaced reclaim, both backends; no _param_N temp, no deep copy, no temp free
