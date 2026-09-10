# Async / Concurrency Design

Documents the concurrency model as shipped and the open questions remaining.
For the user-facing contract, see SPEC.md's "Concurrency" section.

## Implementation status

Shipped on both the C and aarch64 backends (Mutex, Task, Channel all have
`#arch: aarch64` raw-asm blocks; `spawn` and `async` build phases emit aarch64
assembly + C companion). End-to-end usable for concurrency on both targets.

- **`Sendable` trait** — marker, enforced on every spawn arg and every value
  moved into an `async` block. Auto-derived for structs whose fields are all
  Sendable; classes must opt in explicitly.
- **`Task<T>`** — generic, heap-allocated (with `#destroy` cleanup),
  pthread-backed handle parameterised by the spawned function's return type.
  Methods: `wait()` (idempotent), `result()` (blocks, moves the value out —
  a `mov out T`, so a fat string result arrives whole and an unconsumed one
  is freed by destroy), `result_uint64()` (blocks, returns the value cast to
  `uint64`), `cancel()`, `current_cancelled()` (static, thread-local).
  Monomorphized per instantiation (e.g. `Task_uint64`).
- **`Mutex`** — pthread-backed lock; `#destroy` releases the resource.
- **`Channel`** — blocking FIFO queue (`send` / `receive` for uint64 words,
  `send_string` / `receive_string` for fat strings).
- **`spawn`** — statement (fire-and-forget) or expression
  (`var t = spawn fn(args)`) yielding `Task<T>`. Args packed via a per-site
  trampoline, submitted to a global worker pool.
- **`async { ... }`** — nursery block. Waits on every spawned task at scope
  exit. The join runs before block-scoped locals are destroyed, so a running
  task can safely hold pointers to nursery-local values.
- **Unified `Task<T>` handle** — the future behind every spawn is
  reference-counted and shared between the trampoline, the returned Task, and
  the tracking nursery. Join-once semantics, so a Task captured inside a
  nursery is fully usable (explicit `wait()`/`result()`), and the nursery's
  join at block exit is a no-op if the user already joined.
- **Worker pool** — starts at a configurable size (default 4, via
  `Task.set_pool_size(n)` before the first spawn) and grows on demand up to
  64 workers when every worker is busy, preventing deadlocks from nested
  spawns. Drains and joins all workers at process exit;
  `Task.shutdown_pool()` does this explicitly.
- **Cancellation scopes** — `async(timeout: N)` where N is milliseconds.
  Deadline computed before the nursery body runs; `__nomen_future_timedwait()`
  uses `pthread_cond_timedwait` with an absolute deadline. On expiry,
  remaining tasks are cancelled (cancel_flag set) and briefly waited on
  before joining.
- **Race mode** — `async(mode: race) { ... }` exits as soon as the first
  spawned task completes (or the timeout fires); remaining tasks are
  cancelled and joined. Default mode is `all`. Implemented via
  `__nomen_nursery_race_wait`, which polls each future's done flag every 1ms.
- **Nursery escape hatch** — a named `async` block (`async pool { }`) binds a
  `Nursery`-typed variable the caller passes with `ref`;
  `name.spawn(fn(args))` spawns into that nursery. Config rides on the
  declaration: `async pool = Nursery(timeout: N, mode: race) { }`.

## Foundations

Nomen's concurrency model is **structured concurrency via nurseries**, drawing on
https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful/.

The fit with Nomen is clean because the invariants structured concurrency
requires are the ones Nomen already enforces:

- **Black-box control flow.** Every existing construct (if/while/for/func) has
  one arrow in, one arrow out. The nursery requires the same of concurrent
  splits.
- **Scope-bound cleanup.** `#destroy` + auto-free already guarantee "this
  resource is alive for exactly this block, then torn down." A nursery is the
  same idea applied to tasks.
- **`mov` ownership** (see MEMORY.md). The natural primitive for "transfer this
  value to a new owner (a task)" — already implemented, already checked.

## No function coloring

The async "function color" problem
(https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)
is avoided by **putting concurrency at the call site, not on the function.**

Functions are uncolored. `fetch_users(id)` is an ordinary function returning
`User[]`. The caller chooses whether to run it concurrently:

```
// sync
const users = fetch_users(id)

// concurrent — inside an async block:
async {
    let t1 = spawn fetch_users(id)
    let t2 = spawn fetch_orders(id)
    const users  = t1.result
    const orders = t2.result
}
```

- `spawn <call>` runs the call on the enclosing nursery's pool, returns
  `Task<T>`. The runner is implicit, the way `return` implicitly targets the
  enclosing function.
- No `async` keyword on functions. Any function can be spawned.
- `Task<T>.result` blocks the current thread until the task finishes. No
  `await` keyword is required for the thread-pool model (see "Next steps").

This works because Nomen's runtime is **thread-pool based**, not
state-machine/coroutine based — there is no function-body transform that would
require an annotation. A `TaskRunner` parameter was considered and rejected:
it reintroduces coloring via return-type ambiguity (`User[]` vs `Task<User[]>`)
and plumbing explosion, and its only sensible variant is just `spawn` at the
call site.

### Escape hatch: passing the nursery

A function that genuinely needs to spawn into its caller's scope takes the
nursery explicitly (the Trio escape hatch). This is a _capability_, not a
required parameter:

```
func handle_connection = (Connection conn, ref Nursery pool) {
    pool.spawn(parse(conn))
    pool.spawn(respond(conn))
}

async pool {
    handle_connection(conn, ref pool)
}
```

## Cancellation

Cancellation is **ambient**, not threaded through parameters. A task queries
its own cancellation state via `Task.current_cancelled()`; the nursery
propagates cancellation down the task tree automatically.

Two distinct concerns, both parameter-free:

### Resource cleanup is automatic via `#destroy`

When a task exits — normally, by panic, or due to cancellation — its stack
unwinds and every `#destroy` runs, exactly like a normal scope exit. Cleanup is
tied to resource lifetime (RAII), not to how the task ended. No cancellation
plumbing is required for cleanup.

### Cooperative response via `Task.current_cancelled()`

Long-running tasks poll their own cancellation flag at their own checkpoints:

```
func fetch_users = (int id, out User[]) {
    const db = Database.connect(...)
    for page of pages {
        if Task.current_cancelled() { return [] }
        db.fetch_page(page)
    }
}
```

`Task.current_cancelled()` is a runtime query — "which task am I running in?" —
the same shape as how `return` knows which function to return from. Go's
`context.Context` threads cancellation through every signature and is widely
considered a mistake; Trio (cancellation scopes) and Swift (`Task.isCancelled`)
both use ambient cancellation, and so does Nomen.

### Responsibilities

- The task checks `Task.current_cancelled()` → knows about _its own_
  cancellation.
- The nursery handles "cancel everyone below me" → propagates down the tree.
- `#destroy` handles cleanup → runs on any exit path.

None of these require a cancellation parameter.

## Sharing data between tasks

Three tiers, in increasing pain:

1. **Move in.** `mov` or by-value params. Value must be `Sendable`. Ownership
   leaves the caller; the task owns it. Already solved by the `mov` model.
2. **`Channel`.** One-way queue; ownership transfers per message. The channel
   lives in the nursery's scope, so its lifetime is bounded.
3. **`Mutex` / `Atomic`.** Explicit shared mutable state, gated by `Sendable`
   on the guarded type. Opt-in, never the default. Low-level escape hatch —
   prefer an actor (see "Shared mutable state: actors vs. Mutex" below).

Default stance: **no shared mutable state.** Tasks communicate by moving
Sendable values (directly or through channels).

## Next steps

Open questions, intentionally not yet in scope:

- **`await` / suspension.** Needed only if Nomen adds cooperative async I/O
  (state-machine or stack-switching transform). Not required for thread-pool
  tasks, where `Task<T>.result` just blocks. Revisit when there's a real I/O
  story.
- **Typed `Channel<T>`.** `Channel` nodes carry a two-word `(value, len)`
  payload: `send`/`receive` move uint64 words, and
  `send_string`/`receive_string` marshal fat strings (copy-in on send,
  move-out on receive — a message survives its sender's scope exit). A fully
  typed wrapper (`Channel<T>` with native T payloads) remains a
  straightforward stdlib addition.
- **Coroutine-scale concurrency (if ever needed).** The v1 thread-pool model
  caps out at thousands of concurrent tasks (~MB per OS thread). If
  millions-of-tasks scale is ever required, the preferred path is **Go-style
  stack-switching** — colorless, matches Nomen's philosophy, but requires a
  heavy runtime (M:N scheduler, stack copier, syscall interception). The
  **state-machine path** (Rust/Swift-style `async fn` + coloring) should be
  avoided: it trades a permanent language tax for a lighter runtime, a bad
  trade for a small language, and coloring is in fact forced by
  coroutine-aware I/O, not by coroutines themselves. Nothing about
  `async { }`, `Sendable`, `Task<T>`, or the nursery would need redesign
  under either path — only extension. (The full trade-off analysis — runtime
  model comparison, the coloring constraint argued precisely, and the
  language-by-language survey — lived in earlier revisions of this file; see
  git history if it's needed again.)
- **Effect handlers.** A future effect system (a la Koka/OCaml 5) could give
  colorless concurrency without OS-thread-per-task. Large language feature;
  not planned.
- **Error propagation model.** Should nursery failures panic, return a
  `Result`, or both? Tied to the broader error-handling story.

## Shared mutable state: actors vs. Mutex

`Mutex` is the current tier-3 escape hatch for shared mutable state. It is
error-prone (deadlocks, forgotten unlock, no compiler help) and is really a
low-level primitive, not a recommended default. Nomen's stated stance is "no
shared mutable state," and **actors fit that stance better than `Mutex` does.**

An actor serializes access to its state by construction: a task drains a
mailbox and is the only thing that touches the state. No locks, no discipline
required from the caller. Nomen already has the building blocks — an actor is
essentially "a `class` holding state + a `Channel` + a `spawn`ed processor
loop."

### Plan

1. **Pattern first, no new keyword.** Codify the actor idiom in stdlib/docs as
   the recommended way to hold shared mutable state (a `class` + `Channel` +
   processor task, possibly with a small `Actor` base helper). `Mutex` stays
   available for genuinely low-level cases (implementing the actor's own
   queue, lock-free structures, FFI) but is no longer the documented default.
2. **Promote to a first-class `actor` type only if needed.** A keyword earns
   its keep only when we want the _compiler_ to enforce isolation — reject
   direct field access from outside the actor, guarantee all mutation goes
   through the mailbox. That's the real value of Swift-style actors, and also
   the real cost (a new type kind, isolated vs. nonisolated reasoning). The
   signal to promote: users keep foot-gunning shared `class` fields under the
   pure-pattern approach.

### Caveats to resolve before committing to a design

- **No-await means actor calls block.** In a thread-pool runtime, calling an
  actor method is a synchronous RPC — the caller blocks until the actor
  processes the message. Fine and deadlock-free _as long as the actor never
  synchronously calls back into a caller that is waiting on it_ (reentrancy).
  Swift's actor reentrancy rules exist for exactly this; Nomen would need an
  equivalent rule, or a documented "don't call back synchronously" contract.
- **`Mutex` stays regardless.** Even actor-first languages need a lock for
  low-level cases. Actors replace `Mutex` as the _default_ for shared mutable
  state, not as a primitive.
