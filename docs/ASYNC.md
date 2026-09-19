# Async / Concurrency Design

Documents the concurrency model as shipped and the open questions remaining.
For the user-facing contract, see SPEC.md's "Concurrency" section; for the
closure machinery the spawn seam is built on, see [CLOSURE.md](CLOSURE.md).

## Implementation status

Shipped on both the C and aarch64 backends (Mutex, Task, Channel all have
`#arch: aarch64` raw-asm blocks; the `Thread(...).start()` and `async` build
phases emit aarch64 assembly + C companion). End-to-end usable for
concurrency on both targets.

- **`Sendable` trait** — marker, enforced on every spawn arg and every value
  moved into an `async` block. Auto-derived for structs whose fields are all
  Sendable; classes must opt in explicitly.
- **`Task<T>`** — generic, heap-allocated (with `#destroy` cleanup),
  pthread-backed handle parameterised by the spawned function's return type. Methods: `wait()` (idempotent), `result()` (blocks, moves the value out —
  a `mov out T`, so a fat string result arrives whole and an unconsumed one
  is freed by destroy), `result_uint64()` (blocks, returns the value cast to
  `uint64`), `cancel()`, `current_cancelled()` (static, thread-local).
  Monomorphized per instantiation (e.g. `Task_uint64`).
- **`Mutex`** — pthread-backed lock; `#destroy` releases the resource. In
  cooperative mode a fiber try-locks and yields (the holder runs on the same
  thread); in the threaded model a fiber parks on the mutex's wait list
  instead of blocking its worker — unlock wakes the waiters. A cancelled
  waiter keeps waiting (returning without the lock would be unsound) and
  observes the cancel flag at its next checkpoint after acquiring.
- **`Channel`** — blocking FIFO queue (`send` / `receive` for uint64 words,
  `send_string` / `receive_string` for fat strings). Fibers do not block on
  it: an empty `receive` parks the fiber on the channel's wait list
  (park-before-signal under the channel's mutex) and `send` wakes the parked
  receivers; other contexts still block on the condvar. A cancelled fiber
  waiting on an empty channel resumes and returns the zero value rather than
  waiting forever.
- **`Thread`** — the thread class (`core/System/Thread.nm`).
  `Thread(fn(args)).start()` is a statement (fire-and-forget) or expression
  yielding `Task<T>`; the arguments are evaluated EAGERLY, at the
  construction. The construction is a real, storable value:
  `var t = Thread(work(n))` binds the arguments now and `t.start()` runs
  later — and destroying an unstarted value is a programming error that its
  `#destroy` reports and aborts on (must-start). Tasks run on a global
  worker pool.
  `Thread(fn(args)).detach()` is the daemon form: the call runs on its own
  dedicated pthread (never a pool worker), nobody joins it, and process exit
  kills it mid-execution by design — see "Daemon tasks" below.
- **`async { ... }`** — nursery block. Waits on every spawned task at scope
  exit. The join runs before block-scoped locals are destroyed, so a running
  task can safely hold pointers to nursery-local values.
- **`Fiber`** — stackful coroutines over the worker pool
  (`core/System/Fiber.nm`). `Fiber(fn(args)).start()` returns the same
  `Task<T>` handle as a thread spawn, but the call runs on a ~64 KB
  coroutine stack; a fiber that waits (`Task.result`/`wait`) **parks** —
  freeing its worker — and the completion wakes it (park-before-signal under
  the future's mutex, kept in a per-future waiter list; the resumer frees
  the stack at DONE). Like `Thread`, the construction is a storable value
  with must-start `#destroy`. `Fiber.yield()` yields cooperatively,
  `Fiber.is_fiber()` reports fiber context, and
  `Fiber(fn(args)).start_on(buf)` runs on a caller-provided fixed-size array
  stack (>= 16 KB). `Fiber.set_cooperative(true)` runs fibers on the
  calling thread and starts no worker threads: they execute at would-block
  waits or process exit (single-threaded/bare-metal mode). Registration is
  unchanged — a fiber spawned in an `async` block is joined at block exit —
  and the `Thread`/`Fiber` forms share one future, Task, and nursery.
  Cancellation reaches parked fibers: `Task.cancel` (and the nursery
  timeout/race paths) set the flag and schedule the owning fiber, which
  resumes from whatever wait queue it was parked on and observes
  `Task.current_cancelled()` at its next checkpoint. Every time a worker
  resumes a fiber it restores that fiber's task-local cancel flag — a worker
  runs many tasks, so the trampoline's entry-time value cannot be relied on.
  Channel waits in non-fiber contexts poll the cancel flag in bounded
  slices, so a cancelled thread task's `receive` also returns the zero
  value.
- **Spawn arguments are owned by the task env** — string arguments are
  deep-copied at pack (the env destructor frees its copy), and owning
  value-struct arguments are copied and destroyed — a raw copy would alias
  the donor's heap fields and dangle at the donor's scope exit. Class and
  trait arguments stay shared pointers (the Sendable contract). See
  [CLOSURE.md](CLOSURE.md) for the packing machinery.
- **Nursery borrows** — the one Sendable exception: inside `async { }`, a
  non-Sendable CLASS argument may be passed, where it is a borrow capture —
  sound because the join at block exit provably bounds the borrow by the
  donors' lifetimes. The donor must be a named local or parameter (a
  temporary dies at the statement), and `.detach()` never accepts one (a
  daemon outlives every scope and must own its arguments).
- **Function-value constructions** — `Thread(() => work(base))` takes a
  zero-argument function value in place of the unevaluated call: the
  lambda's CAPTURES are the eager arguments (Sendable-validated; owning
  captures move into the task, which owns and disposes the closure). A
  func-typed binding handed to a construction is moved (use-after-move
  afterwards). Also accepted by a nursery's `.start(...)`.
- **`Awaitable`** — the consumption-side trait (`core/System/Awaitable.nm`):
  park-flavored `func wait = (ref self)`. `Task<T>` conforms, so a generic
  helper over `Awaitable` waits on any task — thread, fiber, or
  nursery-spawned. Must-start is deliberately not a trait rule; it is each
  spawn class's own `#destroy` contract.
- **User-defined async primitives** — the construction sugar is not reserved
  for `Thread`/`Fiber`: any user CLASS conforming to `Awaitable` and carrying
  the spawn-field contract (uint64 fields `task` / `result_slot` /
  `cancel_flag` / `future`; an optional `started` bool) can be constructed
  the same way. `Job(fn(args))` / `Job(() => work(n))` pack eagerly and yield
  a heap instance with the handles in the contract fields (vtable installed —
  the value is trait-dispatchable; a generic class monomorphizes with T the
  wrapped return type). Launching is the class's own methods, driving the
  packed-task machinery through the library seam — `Task.pool_submit`,
  `Task.future_wait`, `Task.future_result_uint64`, `Task.future_set_refs`,
  `Task.future_release` — the same runtime calls the generated launch code
  makes, so a user primitive parks fibers, participates in deadlock
  detection, and frees exactly like a library spawn (raw `#arch` blocks
  stay System-library-only). The construction materializes `Task<T>` so the
  seam's statics link. No `#init` runs: the instance is zero-built and the
  handles written, so field defaults stay zero-valid. Must-start is the
  class's own `#destroy` contract, not the compiler's. Tests:
  test/awaitable_ctor.test.ts; SPEC.md, "User-defined async primitives".
- **Unified `Task<T>` handle** — the future behind every spawn is
  reference-counted and shared between the trampoline, the returned Task, and
  the tracking nursery. Join-once semantics, so a Task captured inside a
  nursery is fully usable (explicit `wait()`/`result()`), and the nursery's
  join at block exit is a no-op if the user already joined.
- **Worker pool** — starts at a configurable size (default 4, via
  `Task.set_pool_size(n)` before the first spawn) and grows on demand up to 64 workers when every worker is busy, preventing deadlocks from nested
  spawns. Drains and joins all workers at process exit;
  `Task.shutdown_pool()` does this explicitly.
- **Cancellation scopes** — `async(timeout: N)` where N is milliseconds.
  Deadline computed before the nursery body runs; `__nomen_future_timedwait()`
  uses `pthread_cond_timedwait` with an absolute deadline. On expiry,
  remaining tasks are cancelled (cancel_flag set) and then waited on to
  completion — unconditionally, because releasing a future under a still-
  running task would let the block exit free its resources beneath it
  (a Channel torn down under a still-blocked receiver). A task that never
  observes cancellation hangs its join instead: the documented
  kill-trampoline gap (see FOLLOWUP.md), a liveness hole, not a soundness
  one.
- **Race mode** — `async(mode: race) { ... }` exits as soon as the first
  spawned task completes (or the timeout fires); remaining tasks are
  cancelled and joined to completion. Default mode is `all`. Implemented via
  `__nomen_nursery_race_wait`, which polls each future's done flag every 1ms.
- **Nursery escape hatch** — a named `async` block (`async pool { }`) binds a
  `Nursery`-typed variable the caller passes with `ref`;
  `name.start(Thread(fn(args)))` spawns into that nursery. Config rides on
  the declaration: `async pool = Nursery(timeout: N, mode: race) { }`.

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

The one responsibility the nursery keeps on the caller is liveness: the join at
the closing brace is unconditional, so code after the block cannot help a task
inside finish — a task waiting on a producer outside the block deadlocks
(receive inside the block, or pass the consumer in). Rust's `thread::scope`
carries the identical hazard; its docs resolve it the same way, with the
choreography inside the closure. At runtime, a total deadlock is caught by
the wait-graph detector (see "Deadlock detection" below).

## Daemon tasks

The one legitimate `std::thread::spawn` use case — a process-lifetime service
(log flusher, metrics loop, watchdog) that must NOT block exit — is the
daemon form:

```
Thread(flusher(out)).detach()
```

- **Its own pthread, never a pool worker** — a daemon that never returns
  cannot starve or pin the pool, and `__nomen_pool_shutdown` (the atexit
  join) never waits on it.
- **The std detached-thread contract**: nobody joins the daemon; process
  exit kills it mid-execution, by design. A daemon that must stop cleanly
  owns its own shutdown (a stop channel or flag), not process exit.
- **No handle, no future, no cancellation** — statement form only;
  `Task.current_cancelled()` is always false inside. Args must be
  `Sendable`, exactly like `.start()` — and must be OWNED: `.detach()`
  rejects the nursery-borrow form because the daemon outlives every scope.

This is the deliberate exception to structured concurrency, kept honest by
being explicit: `.start()` creates a bounded, joined task; `.detach()`
creates an unbounded one and says so at the call site.

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
    let t1 = Thread(fetch_users(id)).start()
    let t2 = Thread(fetch_orders(id)).start()
    const users  = t1.result
    const orders = t2.result
}
```

- `Thread(fn(args)).start()` runs the call on the enclosing nursery's pool,
  returns `Task<T>`. The runner is implicit, the way `return` implicitly
  targets the enclosing function.
- No `async` keyword on functions. Any function can be spawned.
- `Task<T>.result` blocks the current thread until the task finishes. No
  `await` keyword is required for the thread-pool model (see "Next steps").

This works because Nomen's runtime is **thread-pool based**, not
state-machine/coroutine based — there is no function-body transform that would
require an annotation. A `TaskRunner` parameter was considered and rejected:
it reintroduces coloring via return-type ambiguity (`User[]` vs `Task<User[]>`)
and plumbing explosion, and its only sensible variant is just
`Thread(...).start()` at the call site.

### Escape hatch: passing the nursery

A function that genuinely needs to spawn into its caller's scope takes the
nursery explicitly (the Trio escape hatch). This is a _capability_, not a
required parameter:

```
func handle_connection = (Connection conn, ref Nursery pool) {
    pool.start(Thread(parse(conn)))
    pool.start(Thread(respond(conn)))
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

## Deadlock detection

A total runtime deadlock aborts with a wait-graph dump instead of hanging
silently (Go's "all goroutines are asleep - deadlock!" model):

```
fatal error: all tasks are asleep - deadlock! (waiting on a task)
  task 0x… parked on channel receive (waiters 0x…)
  task 0x… parked on mutex 0x… (held by task 0x…)
```

The check runs at the moments a thread commits to blocking forever — an
indefinite task wait (`Task.result`/`wait`, the nursery join on a raw
thread) and an idle pool worker's wait when some thread is so committed. It
fires only when nothing can run: the fiber run queue is empty, no pool task
is queued or executing, no fd is registered with the netpoller, and at
least one fiber is parked. Both check paths re-verify after a short sleep,
so a wake mid-delivery is never misjudged; each parked fiber is dumped with
its park site (future / channel / mutex / io) and, for a mutex, the
current holder.

Known blind spot (the same one Go's detector has): a raw blocking call
holds no node in the wait graph — blocking FFI, a `Thread`-model task
parked on a `Channel`/`Mutex` condvar (which blocks its worker), or a
non-fiber thread blocked in `Channel.receive`. A program kept alive only by
such calls cannot be distinguished from a deadlock and may not be flagged.
Timeouts and race mode never trip the detector: a deadline can still rescue
the graph, so timed waits are exempt by design.

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

## Roadmap (remaining)

The coroutine-scale arc (fibers, park-aware blocking, the netpoller) is
shipped; what remains, in rough value order:

- **Fiber stack growth.** Stacks are fixed at 64 KB (~16k tasks/GB). 8 KB
  initial stacks with growth need either guard-page SIGSEGV handling
  (library-only, hairy) or compiler-inserted stack-limit checks (small
  codegen change). The scale lever: millions of tasks.
- **10k-connection acceptance run.** The netpoller is validated to N = 64
  concurrent connections (`test/tcp.test.ts`); the coroutine-scale
  acceptance target has not been attempted.
- **Parking-reachability lint.** Advisory ("this parks") diagnostics
  scoped to fiber-reachable code: a baseline of park-capable calls
  (`Task.result`/`wait`, `Channel.receive`, `Mutex.lock`,
  `wait_for_io`-backed primitives) plus a channel-end advisory. Explicitly
  never a rule — see "No function coloring".
- **`Runtime` trait.** The single-threaded mode is a global flag
  (`Fiber.set_cooperative`); the planned WorkerRuntime/CooperativeRuntime
  trait abstraction (custom schedulers without retrofitting) is not built.
- **io_uring backend.** Linux completion-based I/O alongside the
  readiness-based kqueue/epoll poller.
- **Forced-unwind kill trampoline.** Cancellation is cooperative; a task
  that never polls its flag hangs its nursery's join. The full fix — push a
  teardown frame onto the parked stack and let `#destroy` unwinding run —
  needs forced stack unwinding of suspended frames (see FOLLOWUP.md).
- **FFI reentry.** An `extern` C callback that calls back into Nomen gets
  no fiber context (Go's cgo problem).
- **Windows.** x86-64 `switch_context` plus an IOCP-shaped
  `wait_for_io` (or a wepoll-style shim).
- **`Fiber.dump_all()`.** Debug aid: backtrace-per-fiber, scheduler
  visibility.
- **`await` sugar.** Shelved by design — `.result()` inside a fiber IS the
  await point; a keyword would be decorative (see "No function coloring").
  Valid only as `await <Awaitable>` ≡ `.wait()` if grep-ability is ever
  missed.

Open questions, intentionally not yet in scope:

- **Typed `Channel<T>`.** `Channel` nodes carry a two-word `(value, len)`
  payload: `send`/`receive` move uint64 words, and
  `send_string`/`receive_string` marshal fat strings (copy-in on send,
  move-out on receive — a message survives its sender's scope exit). A fully
  typed wrapper (`Channel<T>` with native T payloads) remains a
  straightforward stdlib addition.
- **Effect handlers.** A future effect system (a la Koka/OCaml 5) could give
  colorless concurrency without OS-thread-per-task — and `switch_context`
  quietly makes handlers a possible library/stdlib feature later, without
  committing to effect rows in the type system. Large language feature;
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
