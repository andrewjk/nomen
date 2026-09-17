---
nomen-lang: minor
---

Replace the spawn keyword with the Thread class: spawn fn(args) becomes Thread(fn(args)).start(), and the nursery escape hatch name.spawn(fn(args)) becomes name.start(Thread(fn(args))); spawn leaves the reserved-words list (Phase 0 of ASYNC_PLAN.md)
