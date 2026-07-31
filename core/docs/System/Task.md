# Task

## `class Task<T>`

A handle to an asynchronously-running computation, backed by a shared thread pool

**Members:**

- `wait()`
- `result() -> T`
- `result_uint64() -> uint64`
- `cancel()`
- `current_cancelled() -> bool`
- `set_pool_size(int n) -> int`
- `shutdown_pool()`
