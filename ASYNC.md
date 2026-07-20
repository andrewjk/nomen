# Async / Concurrency Design

Work in progress. Captures conclusions as the design evolves.

## Foundations

Echo's concurrency model is **structured concurrency via nurseries**, drawing on
https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful/.

The fit with Echo is unusually clean because the invariants structured
concurrency requires are the ones Echo already enforces:

- **Black-box control flow.** Every existing construct (if/while/for/func) has
  one arrow in, one arrow out. The nursery requires the same of concurrent
  splits.
- **Scope-bound cleanup.** `#destroy` + auto-free already guarantee "this
  resource is alive for exactly this block, then torn down." A nursery is the
  same idea applied to tasks.
- **`mov` ownership** (see MEMORY.md). The natural primitive for "transfer this
  value to a new owner (a task)" — already implemented, already checked.

## No function coloring

The async "function color" problem (https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)
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
    // block does not exit until t1 and t2 finish
    const users  = t1.result
    const orders = t2.result
}
```

- `spawn <call>` runs the call on the enclosing nursery's pool, returns
  `Task<T>`. The runner is implicit, the way `return` implicitly targets the
  enclosing function.
- No `async` keyword on functions. Any function can be spawned.
- `Task<T>.result` blocks the current thread until the task finishes. No
  `await` keyword is required for v1 (see "Deferred" below).

This works because Echo's runtime is **thread-pool based**, not
state-machine/coroutine based. There is no function-body transform that would
require an annotation.

### Why not a `TaskRunner` parameter

Considered: making functions take an optional `TaskRunner?` so the same
function could be called sync or async. Rejected because:

1. **Return-type ambiguity.** Does `fetch_users(id, runner)` return `User[]` or
   `Task<User[]>`? Either the return type depends on a runtime arg (untypeable
   in Echo without overloading on nullability), or every sync caller has to
   unwrap a Task. The "color" is really the return type, not the annotation.
2. **Plumbing explosion.** If `fetch_users` internally calls `db.query`, and we
   want that to be concurrent when the outer call is, then `db.query` also
   needs a `runner` param — and so does everything it calls. Coloring via
   plumbing is worse than coloring via annotation.
3. **Option (b) is just `spawn`.** If only the top-level call is concurrent and
   internal calls are sync (the only sensible default), then `spawn` at the
   call site does the same job without touching the function's signature.

### Escape hatch: passing the nursery

A function that genuinely needs to spawn into its caller's scope takes the
nursery explicitly (the Trio escape hatch). This is a _capability_, not a
required parameter:

```
func handle_connection = (Connection conn, ref Nursery nursery) {
    nursery.spawn(parse, conn)
    nursery.spawn(respond, conn)
}

async {
    handle_connection(conn, ref nursery)
}
```

## Primitives

### `Sendable` (marker trait)

`Sendable` marks types whose values are safe to move across task boundaries.
No methods. Lives in `core/System/Sendable.echo` as:

```
pub trait Sendable {
}
```

Auto-derivable: a struct is `Sendable` iff every field is `Sendable`. The
compiler checks this at struct definition time (mirrors how `Disposable` and
`Enumerable` are special-cased). Primitives (`int`, `float`, `bool`, `char`),
`string`, and arrays of `Sendable` types are `Sendable` by default.

Every value moved into an `async` block or passed to `spawn` must be `Sendable`.

### `Task<T>` (handle)

The handle returned by `spawn`. Tracks one running task.

```
pub struct Task<T: Sendable> : Sendable {
    func cancelled = (self, out bool)      // has cancel been requested?
    func cancel   = (var self)             // request cooperative cancel
    func result   = (var self, out T)      // block until done, return value
}
```

Cancellation is cooperative: `cancel` sets a flag; the task observes it at
its own checkpoints (today: by polling `Task.current().cancelled`). The
nursery never terminates a task without giving it a chance to run `#destroy`.

### `async { }` block (nursery)

Defines a scope in which `spawn` can be used. The block does not exit until
all tasks spawned within it have completed (successfully, cancelled, or
failed). If any child fails, the nursery cancels the others before exiting,
and propagates the failure to the parent (modeled as a panic or `Result`
depending on what the error story settles on).

## Cancellation

Cancellation is **ambient**, not threaded through parameters. A task queries
its own cancellation state via `Task.current().cancelled`; the nursery
propagates cancellation down the task tree automatically.

Two distinct concerns, both parameter-free:

### Resource cleanup is automatic via `#destroy`

When a task exits — normally, by panic, or due to cancellation — its stack
unwinds and every `#destroy` runs, exactly like a normal scope exit. Cleanup
is tied to resource lifetime (RAII), not to how the task ended:

```
func fetch_users = (int id, out User[]) {
    const db = Database.connect(...)   // Database has #destroy that closes
    // ...work...
    // db.close() happens automatically on return, panic, OR cancel
}
```

No cancellation plumbing is required for cleanup.

### Cooperative response via `Task.current().cancelled`

If a task is long-running (loops, multi-stage work), it polls its own
cancellation flag at its own checkpoints:

```
func fetch_users = (int id, out User[]) {
    const db = Database.connect(...)
    for page of pages {
        if Task.current().cancelled { return [] }
        db.fetch_page(page)
    }
}
```

`Task.current()` is a runtime query — "which task am I running in?" — the
same shape as how `return` knows which function to return from. Cancellation
is a property of the current task, not a value to pass.

### Why ambient, not threaded

Go's `context.Context` threads cancellation through every signature and is
widely considered a mistake. Trio (cancellation scopes) and Swift
(`Task.isCancelled`) both use ambient cancellation. The structural-concurrency
argument is the same as for nurseries: cancellation flows down the task tree
automatically, and the runtime knows which task "you" are.

### Responsibilities

- `fetch_users` checks `Task.current().cancelled` → knows about _its own_
  cancellation.
- The nursery handles "cancel everyone below me" → propagates down the tree.
- `#destroy` handles cleanup → runs on any exit path.

None of these require a cancellation parameter on `fetch_users`.

### Sharing data between tasks

Three tiers, in increasing pain:

1. **Move in.** `mov` or by-value params. Value must be `Sendable`. Ownership
   leaves the caller; the task owns it. Already solved by the `mov` model.
2. **`Channel<T: Sendable>`.** One-way queue; ownership transfers per message.
   The channel lives in the nursery's scope, so its lifetime is bounded.
3. **`Mutex<T>` / `Atomic<T>`.** Explicit shared mutable state, gated by
   `Sendable` on `T`. Opt-in, never the default.

Default stance: **no shared mutable state.** Tasks communicate by moving
Sendable values (directly or through channels).

## Phasing

Given that no closures, runtime, or threads exist today:

1. **`Sendable` trait + auto-derive** — pure compile-time, reuses trait
   plumbing 100%. No runtime impact. Commits to nothing else.
2. **`core/System/Task.echo` runtime** — `#arch: c` → pthreads;
   `#arch: aarch64` → dispatch/libdispatch or pthreads. Pool, spawn, join.
3. **`async { }` block + `spawn` + `Task<T>`** — parse/check/build mirror
   `WhileLoopNode` almost exactly. One new NodeType, ~6 small files.
4. **`Channel<T>` and `Mutex<T>`** — stdlib on top of the runtime.
5. **Cooperative cancellation** — `Task.current()`, cancellation scopes,
   checkpoint insertion at I/O boundaries.

## Deferred

Open questions, intentionally out of scope for v1:

- **`await` / suspension.** Needed only if Echo adds cooperative async I/O
  (state-machine transform). Not required for thread-pool tasks, where
  `Task<T>.result` just blocks. Revisit when there's a real I/O story.
- **Effect handlers.** The "no coloring" property is currently bought with
  threads. A future effect system (a la Koka/OCaml 5) could give the same
  property without OS-thread-per-task, but that's a large language feature.
- **Cancellation scope semantics** (Trio-style lexically-scoped timeouts).
  Depends on having checkpoints (i.e. on `await`).
- **Error propagation model.** Should nursery failures panic, return a
  `Result`, or both? Tied to the broader error-handling story.

## Runtime models

Concurrency can be implemented three fundamentally different ways. The
distinction that matters for language design is **not** "threads vs
coroutines" — it's whether coroutines are implemented via **state-machine
transform** (which forces coloring) or via **stack switching** (which
doesn't).

|                    | OS thread               | Coroutine + **stack switch**   | Coroutine + **state machine**     |
| ------------------ | ----------------------- | ------------------------------ | --------------------------------- |
| Coloring?          | no                      | **no**                         | yes                               |
| Per-task cost      | ~MB                     | ~KB                            | very small                        |
| Runtime complexity | low                     | high (scheduler, stack copier) | medium                            |
| Blocking I/O       | fine                    | runtime intercepts syscalls    | must be non-blocking              |
| Examples           | Echo v1, pre-async Rust | **Go**, Erlang                 | Rust async, Swift, C#, JS, Python |

The v1 design assumes a **thread-pool runtime** (1 task = 1 OS thread, drawn
from a pool). Tasks are plain code, no transform required — which is what
lets us avoid function coloring.

If we ever need coroutine-scale concurrency (millions of tasks, cheap I/O
multiplexing), the choice between stack-switching and state-machine
implementations is the most consequential decision:

- **Stack-switching (Go-style).** Colorless. Functions don't know they're on
  a coroutine; their bodies are just code running on a growable stack
  segment. `go fn(args)` packages the call, allocates a stack, schedules it.
  No annotation, no transform, no return-type change. Cost: heavy runtime
  (M:N scheduler, stack copier, syscall interception layer).
- **State-machine (Rust/Swift/C#-style).** Coloring required. Compiler
  transforms each task body into a state machine — locals hoisted into a
  struct, body becomes a `poll()` function, return type changes
  (`T` → `Future<T>`). Cost: every function in a suspending call chain must
  be transformed; callers must `await`.

**The "function coloring is required for coroutines" claim is wrong in
general** — it's only required for the state-machine implementation. Go's
goroutines are coroutines and have no coloring.

### What changes if we moved to state-machine coroutines

This is the path that introduces coloring. Don't take it without weighing
the stack-switching alternative first.

| Area                | Thread-pool (v1)                     | State-machine coroutine                              |
| ------------------- | ------------------------------------ | ---------------------------------------------------- |
| Function annotation | none                                 | `async fn` for anything that `await`s                |
| `spawn`             | runs fn on worker, returns `Task<T>` | schedules coroutine, returns `JoinHandle<T>`         |
| Result              | `Task<T>.result` blocks thread       | `.await` only; `.result` removed (deadlocks)         |
| I/O                 | blocking is fine                     | all I/O must be non-blocking (epoll/kqueue/io_uring) |
| Cancellation        | task polls flag                      | injected at await points (Trio scopes)               |
| Stack traces        | normal                               | synthesized from state machine — hard                |
| FFI                 | trivial                              | blocking C calls starve runtime                      |
| Compiler            | no extra pass                        | state-machine transform is a new lowering            |

### What changes if we moved to stack-switching coroutines

This is the Go path. Colorless, but heavy runtime.

| Area                | Thread-pool (v1)               | Stack-switching coroutine (Go-style)                  |
| ------------------- | ------------------------------ | ----------------------------------------------------- |
| Function annotation | none                           | **none**                                              |
| `go` (or similar)   | n/a                            | packages call, allocates stack, schedules             |
| Result              | `Task<T>.result` blocks thread | yields (must not block — parks the coroutine)         |
| I/O                 | blocking is fine               | runtime intercepts syscalls, parks coroutine          |
| Cancellation        | task polls flag                | same — cooperative polling                            |
| Stack traces        | normal                         | synthesizable (real stacks, but segmented)            |
| FFI                 | trivial                        | fine, but blocking calls park the whole worker thread |
| Compiler            | no extra pass                  | no extra pass                                         |
| Runtime             | small (pthread pool)           | large (M:N scheduler, stack copier, syscall hooks)    |

### What stays the same either way

- `async { }` nursery block
- `Sendable` trait (especially with multi-thread executors)
- `Channel<T>`, structured concurrency model
- Escape-hatch nursery parameter

### Potential API: `spawn` vs `go`

If Echo ever supports both thread-pool and coroutine execution, the call-site
keyword distinguishes them. Functions stay un-colored; the caller picks:

```
async {
    let t1 = spawn parse_big_file(data)   // CPU-bound → OS thread
    let t2 = go   fetch_remote(url)        // I/O-bound → coroutine
    // nursery joins both
}
```

Catch: `.result` semantics differ between contexts. A thread calling
`.result` on a coroutine parks the OS thread (fine). A coroutine calling
`.result` on another coroutine on the same worker must yield — not block —
or it deadlocks the executor. The runtime needs to know which kind of task
is calling `.result` and behave accordingly.

## The coloring constraint, precisely

**Function coloring is not required by coroutines — it's required by
coroutine-aware I/O.** The confusion arises because state-machine coroutines
and coloring are bundled together in most languages (Rust, Swift, C#), but
they're logically separable.

### Why coloring exists

The win of coroutines over threads is cheap concurrent I/O: when one task
hits a syscall, it _yields_ back to the scheduler so another task can run on
the same worker thread. For this to work, the I/O operation itself must be
able to suspend — which means the function doing the I/O must propagate
suspension upward, and so must its callers. Coloring spreads from the I/O
layer through the call graph.

There are exactly two ways to make I/O coroutine-aware:

1. **Runtime interception (Go, Erlang).** The runtime wraps every syscall.
   `read(fd, buf, n)` actually calls into the runtime, which parks the
   coroutine, registers with epoll/kqueue, resumes when ready. Functions
   don't know this is happening — they just call `read` and "block." No
   coloring, but heavy runtime (syscall wrappers, event loop, stack copier,
   the whole goroutine scheduler).
2. **Explicit coloring (Rust, Swift, C#, JS, Python).** I/O functions are
   `async fn read_bytes() -> Future<...>`. Callers must `await`. The compiler
   transforms each function in the chain into a state machine. No runtime
   interception needed, but every function between you and the syscall is
   colored.

**There is no third option.** Zig (option 3, "colorless via inference")
doesn't escape this — it hides the coloring via compiler inference, but its
I/O layer is still coroutine-aware via interception, same as Go.

A common proposal: have I/O primitives check `Coroutine.current()` at
runtime and dispatch — block if sync, suspend if coroutine. This is a real
pattern (Go's runtime does something similar) but it **doesn't avoid
coloring**, because coloring was never about I/O dispatch. Coloring is about
function body shape. Two cases:

- **Stack-switching coroutines (Go-style).** Bodies are normal code,
  suspension means parking the whole stack segment. I/O primitives can
  check `Coroutine.current()` and dispatch — but this is just a minor
  optimization over Go's default (which always routes through the runtime).
  There was no coloring to escape in this model.
- **State-machine coroutines (Rust/Swift-style).** If a function suspends,
  its body must be compiled as a state machine — locals hoisted into a
  struct, body rewritten as `poll()`. That's a compile-time decision. The
  body is _either_ a state machine _or_ normal code; you can't switch at
  runtime based on `Coroutine.current()`. Compiling everything as a state
  machine doesn't help either — sync callers then get `Future<T>` instead
  of `T`, and coloring has returned hidden behind a runtime check.

The two concerns are orthogonal:

| Concern                                     | Where it lives     | `Coroutine.current()` dispatch addresses it? |
| ------------------------------------------- | ------------------ | -------------------------------------------- |
| I/O dispatch (block vs suspend)             | I/O primitives     | yes                                          |
| Function body shape (code vs state machine) | Compiler transform | no                                           |

The only way `Coroutine.current()` dispatch truly works is if function
bodies are identical in both modes — which requires stack-switching
coroutines. And then you're in Go's model with the heavy runtime. No escape.

### Why "just wrap sync code as a coroutine" doesn't escape coloring

A natural proposal: write a coroutine wrapper that calls a sync function.
Mechanically this works — it's `spawn_blocking` in Rust, `Task.Run` in C#.
But the wrapper doesn't suspend. It hits the sync function, which makes a
blocking syscall, which parks the worker thread in the kernel until the
syscall returns. The coroutine scheduler can't preempt it (cooperative
scheduling only). One coroutine has hogged one worker thread for the
duration. If you have N workers, you can only run N of these wrappers
concurrently before throughput collapses. **You've rebuilt thread-pool with
extra steps.**

The state-machine wrapper adds overhead without benefit because nothing in
the call chain actually suspends. The wrapper exists in production code, but
as an _escape hatch_ for genuinely-blocking code in a coroutine world — it
runs the work on a separate thread pool so it doesn't freeze the coroutine
executor. It's threads doing the work, not coroutines.

### Implication for Echo

Echo has two clean paths:

1. **Stay thread-pool forever.** No coloring, simple runtime, blocking I/O
   is fine. Per-task cost (~MB) limits you to thousands of concurrent tasks.
   Adequate for most programs.
2. **Add coroutine-scale I/O via runtime interception (Go-style).** Colorless,
   matches Echo's philosophy, but requires building a heavy runtime: syscall
   wrappers, an event loop, a scheduler, stack copying. The `Task<T>` handle
   and nursery model transfer cleanly.

The state-machine path (Rust/Swift-style coloring) should be avoided — it
trades a permanent language tax (coloring) for a lighter runtime, and Echo
is a small language where the tax is felt disproportionately.

### Comparison with existing languages

|                           | Swift                | Zig                  | Rust                   | C#                        | Go                       | Echo v1                  |
| ------------------------- | -------------------- | -------------------- | ---------------------- | ------------------------- | ------------------------ | ------------------------ |
| Implementation            | state machine        | state machine        | state machine          | state machine             | **stack switch**         | OS thread                |
| Coloring                  | opt-in bridge        | inferred (colorless) | strict                 | strict                    | **none**                 | none (call-site `spawn`) |
| Coroutine transform       | yes                  | yes (conditional)    | yes                    | yes                       | **no**                   | no                       |
| Runtime                   | in std (libdispatch) | in std (in flux)     | library (tokio et al.) | in std (CLR ThreadPool)   | in std (heavy scheduler) | in std (planned)         |
| Per-task cost             | small                | small                | very small             | small                     | small                    | ~MB (OS thread)          |
| Cancellation              | cooperative          | cooperative          | drop the future        | `CancellationToken` param | cooperative              | cooperative (ambient)    |
| Origin of `async`/`await` | 2021                 | 2018                 | 2019                   | **2012 (origin)**         | n/a (no syntax)          | n/a                      |

**Go** — proof that colorless coroutines work at scale. `go fn(args)` packages
the call, allocates a 2KB growable stack, schedules on the M:N runtime.
Functions are unmodified; blocking I/O is intercepted by the runtime wrapping
syscalls. Heavy runtime (scheduler, stack copier, preemption, GC integration)
is the cost. Industry validation: most modern concurrent backend services run
on goroutines. This is the model to take most seriously for Echo if it ever
needs coroutine scale.

**Swift (option 1)** — opt-in `async fn`, regular functions stay un-colored.
`Task { await fn() }` bridges sync→async. Predictable, explicit, introduces
_some_ coloring. State-machine implementation. Safest upgrade path among
state-machine options.

**Zig (option 3)** — colorless via compiler inference. Functions aren't
annotated; the compiler scans for suspension points and compiles to coroutine
or normal code accordingly. Caller is unaware. Genuinely distinct from Swift
(opt-in) and Go (stack-switching). Costs: signatures don't reveal suspension
possibility, hard to reason locally, complex implementation. Caveat: Zig
removed its explicit `async`/`await` keywords around 0.11–0.12 and is
rebuilding the I/O story — the colorless experiment is partially in retreat.
See https://kristoff.it/blog/zig-new-async-io/.

**Rust** — strict coloring via `async fn` → `impl Future<Output = T>`. Body
becomes a hand-rolled state machine. Sync→async bridging requires a runtime's
`block_on`. Runtime is library-provided (tokio, async-std, smol, glommio) —
deliberately not in std, famously controversial. `Send` trait is the analog
of `Sendable`. `spawn_blocking` for sync code that must block. Zero-cost
(state machine laid out by compiler, no heap alloc unless `Box::pin`). The
explicitness is what enables the optimization. Worth avoiding for Echo: it
pushes runtime-choice complexity onto users for limited benefit in a small
language.

**C#** — origin of `async`/`await` (C# 5.0, 2012); the syntax every other
language copied. Strict coloring, state machine transform, like Rust.
Historical precedent that matters: C# shipped **TPL** (Task Parallel Library, 2010) — a thread-pool model with `Task<T>`, `Task.Run`, `Parallel.For` — _two
years before_ `async`/`await` was layered on top. `Task<T>` is shared by both
models; TPL is still heavily used. This is the upgrade path Echo's v1 is on:
thread-pool first, possibly coroutine coloring later, same `Task<T>` handle.

Two anti-patterns to avoid (C# is the textbook caution):

- **`CancellationToken`** — explicit threading of cancellation through every
  signature. Universally considered noisy. Go's `context.Context` is the same
  pattern, also widely disliked. Echo's ambient `Task.current().cancelled`
  (Swift/Trio model) is the deliberate alternative.
- **`ConfigureAwait(false)`** — C# couples resumption to a "synchronization
  context" (UI thread, ASP.NET request context). After `await`, code resumes
  on the captured context — useful for UI, disastrous for libraries
  (deadlocks, perf). Library authors write `ConfigureAwait(false)` everywhere.
  Direct consequence of tying resumption to thread/affinity. Design lesson:
  **don't couple resumption to a thread or context.**

**Echo v1** is closest to "pre-async Rust" (`std::thread::spawn` +
`JoinHandle`), and to C# TPL pre-async/await.

### Upgrade routes, revised

If coroutine-scale concurrency is ever needed:

1. **Go-style stack-switching (preferred).** Colorless, matches Echo's
   philosophy. Cost: heavy runtime investment. The `Task<T>` handle and
   nursery model transfer cleanly.
2. **State-machine opt-in (Swift-style).** Lighter runtime, but introduces
   coloring. Take this only if Go-style proves infeasible.
3. **Strict state-machine (Rust-style).** Avoid — pushes complexity onto
   users for limited benefit in a small language.

The v1 design is compatible with all three: nothing about `async { }`,
`Sendable`, `Task<T>`, or the nursery would need to be redesigned — only
extended. Revisit only when Echo has a real I/O story that demands it.
