---
nomen-lang: minor
---

Park-aware Channel: an empty receive from a fiber parks on the channel wait list instead of blocking its worker, send wakes parked receivers, and a cancelled waiter returns instead of waiting forever; cancellation now reaches parked fibers (Task.cancel/nursery timeout schedule the owning fiber and restore its task-local cancel flag on resume); fix __nomen_future_timedwait to use a real absolute deadline
