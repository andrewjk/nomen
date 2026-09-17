---
nomen-lang: minor
---

Add Fiber: stackful coroutine tasks over the worker pool. Fiber(fn(args)).start() yields a Task<T> like Thread, but a waiting fiber parks (freeing its worker) instead of blocking; Fiber.yield/is_fiber, Fiber.start_on(buffer) on a caller-provided stack (C backend), and Fiber.set_cooperative for no-thread single-threaded runs
