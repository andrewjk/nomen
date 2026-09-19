---
nomen-lang: minor
---

The Awaitable construction sugar generalizes beyond Thread/Fiber: any user class conforming to Awaitable with the spawn-field contract (uint64 task/result_slot/cancel_flag/future, optional started) takes the same eagerly-packed construction, launches through the new Task.pool_submit / Task.future_* library seam, dispatches through the Awaitable vtable, and monomorphizes as C<T>; a contract-missing class gets a dedicated compile error
