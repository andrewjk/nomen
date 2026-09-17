# Async Plan: Coroutine-Scale Concurrency

Plans the extension of the concurrency model to coroutine scale (100k+ concurrent
tasks) and real async I/O. The shipped model is documented in
[ASYNC.md](ASYNC.md); read that first — this doc extends it, nothing here
redesigns it.

## Problem

The v1 thread-pool model (ASYNC.md "Next steps") caps out at thousands of
concurrent tasks: every task is an OS thread (~MB of stack), and blocking I/O
pins a whole worker. Two applications need more:

- **Async I/O** — a server holding 10k+ open connections can't afford a
  blocked worker per connection.
- **Coroutine scale** — millions of mostly-idle tasks (agents, actors,
  fan-out/fan-in) can't afford an OS thread each.

ASYNC.md framed the choice as Go-style stack switching (colorless, heavy
runtime) vs Rust/Swift-style state machines (light runtime, permanent coloring
tax). There is a third path that threads the needle.

## Decision

**Stackful fibers, implemented as a library on top of a tiny stack-switch
primitive.** No function transform, no coloring, and no new keywords — one
keyword (`spawn`) is _removed_ (see Library surface).

The insight that makes this cheap: the cost of the state-machine path is a
transform on _every function body_. But the only places that need to know
about the execution context are the **blocking points** — `Task.result()`,
`Channel.receive()`, `Mutex.lock()`, and future I/O calls. Those already loop
on a futex/condvar (`__nomen_future_timedwait` etc.). Change the wait loop to
consult an ambient runtime first:

- on a raw worker thread → block, exactly as today;
- inside a fiber → park the fiber's stack and switch to the scheduler.

Everything else follows from locating the check there instead of in every
function.

### Compiler surface (deliberately tiny)

1. **`switch_context(from_sp, to_sp)` + `make_context(stack, entry, arg)`** —
   the stack-switch primitive, `#arch: aarch64` raw asm in the stdlib (same
   mechanism as `umulh`; ~50 lines: SP, LR, FP, x19–x28). A `Fiber` is a
   heap-allocated stack plus one context.
2. **`Runtime.current()`** — ambient, fiber-local pointer to the active
   scheduler (TLS on threaded targets; a plain global on single-threaded and
   bare-metal targets). _Not_ a passed parameter — ASYNC.md's own argument
   against threading `context` through signatures (the rejected `TaskRunner`)
   applies. Ambient is the house style.

That is the whole compiler/runtime surface. `await`, growable stacks, and
effect handlers are all library concerns on top of it (or deferred, see
below).

### Library surface

- **`Thread`** — the existing model as a class, replacing the `spawn`
  keyword. Symmetry with `Fiber` is the point: same call shape, same
  `Task<T>` handle, same `Awaitable` conformance. The `spawn` keyword leaves
  the reserved-words list (SPEC's list is precious real estate); migration is
  mechanical (`spawn fn(args)` → `Thread(fn(args)).start()`). Fire-and-forget
  survives as the discarded-handle statement form — the nursery still tracks
  the future, exactly as `spawn fn(args)` does today.
- **`Fiber`** — a stackful coroutine: ~8 KB heap stack, context init, entry
  trampoline. `Fiber(fn(args)).start()` returns the **existing `Task<T>`**
  handle — fibers plug into the unified future/join machinery ASYNC.md
  already ships (ref-counted future shared between trampoline, handle, and
  tracking nursery; join-once). Arguments must be `Sendable` — same rule,
  same per-site trampoline packing as `spawn`. `start_on(stack_buffer)`
  allocates the fiber on caller-provided storage instead of the heap (the
  bare-metal path, see Embedded).
- **`Runtime` trait, not a sealed runtime.** The stdlib ships two
  implementations and users may write their own:
  - `WorkerRuntime` — the desktop/server default: worker-pool threads,
    netpoller, work scheduling over the existing pool.
  - `CooperativeRuntime` — one thread, run-to-completion loop, no
    preemption; fibers yield only when they park. Runs anywhere C runs,
    including bare metal (see Embedded).
    The trait is designed in from day one so embedded/custom schedulers never
    require retrofitting the primitive layer.
- **Scheduler** — multiplexes runnable fibers over the existing worker-pool
  threads. A parked fiber frees its worker; the pool never grows because a
  fiber is waiting.
- **`Awaitable` trait** — park-flavored: `func wait = (self)` may park the
  current execution context. Both `Task<T>` and `Fiber` satisfy it. A
  Rust-style `poll`/`Waker` trait is explicitly rejected — it smuggles the
  state-machine transform back in through the trait definition.
- **Netpoller** (Phase 3) — kqueue on darwin, epoll on Linux. Stdlib I/O goes
  through one ambient hook: `Runtime.current().wait_for_io(fd, want_write)`.
  Under the thread model it performs the blocking syscall (today's behavior);
  under the fiber model it registers with the poller and parks. **One
  stdlib, correct under both models** — this is what makes "user picks the
  execution model per call site" work. On Windows the native answer is IOCP,
  which is _completion_-based rather than readiness-based; the hook absorbs
  the difference (epoll backend registers interest and parks; IOCP backend
  posts an overlapped op and parks — callers never see it), with a
  wepoll-style epoll-over-IOCP shim as the low-effort fallback. Windows
  support for fibers additionally requires an x86-64 `switch_context`
  backend, so it rides along with that larger piece of work.

## Syntax

Functions are uncolored — the caller chooses the execution model, per
ASYNC.md's "concurrency at the call site" principle. Here is the same program
in both forms.

### Before: plain synchronous code

Everything waits in sequence. Total wall time is the _sum_ of the two HTTP
round trips plus the full compute run:

```
import System

// NOTE: fetch_user is byte-for-byte identical in the async version below.
func fetch_user = (uint64 id, out string) {
    const resp = Http.get("https://api.example.com/users/\{id}")   // blocks
    return resp.body
}

func fetch_pair = (uint64 a, uint64 b, out string) {
    const string first = fetch_user(a)     // waits for the full round trip
    const string second = fetch_user(b)    // then waits again
    return first + " & " + second
}

func crunch = (uint64 iterations, out uint64) {
    var uint64 acc = 0
    var uint64 i = 0
    while i < iterations; acc += i % 7 {
        i += 1
    }
    return acc
}

func main = () {
    const names = fetch_pair(1, 2)       // blocks on network I/O
    const uint64 c = crunch(10_000_000)  // then blocks on compute
    Console.write_line(names)
    Console.write_line("checksum: \{c}")
}
```

### After: the async version

`fetch_user` is unchanged — that is the payoff of no coloring. The only
edits are at the call sites, where the caller picks an execution model. Total
wall time becomes roughly _max_(round trips) for the fetches, with the
compute running on its own thread in parallel:

```
import System

// Uncolored. Nothing here mentions concurrency — this function runs the same
// whether it's called directly, started as a Thread, or started as a Fiber.
func fetch_user = (uint64 id, out string) {
    const resp = Http.get("https://api.example.com/users/\{id}")   // parks (Phase 3)
    return resp.body
}

// Sequential dependent fetches. On a Thread, `result()` blocks a whole
// worker. As a Fiber, it parks — the worker runs other fibers meanwhile.
func fetch_pair = (uint64 a, uint64 b, out string) {
    const ra = Fiber(fetch_user(a)).start()
    const rb = Fiber(fetch_user(b)).start()
    const string first = ra.result()   // parks this fiber; rb keeps running
    const string second = rb.result()
    return first + " & " + second
}

// CPU-bound work: still happiest on a real thread.
func crunch = (uint64 iterations, out uint64) {
    var uint64 acc = 0
    var uint64 i = 0
    while i < iterations; acc += i % 7 {
        i += 1
    }
    return acc
}

func main = () {
    async {
        const cpu = Thread(crunch(10_000_000)).start()   // Thread model
        const io = Fiber(fetch_pair(1, 2)).start()       // Fiber model

        const names = io.result()    // main blocks here — the nursery join point
        Console.write_line(names)
        Console.write_line("checksum: \{cpu.result_uint64()}")
    }
}
```

Notes:

- **There is no `await`.** `ra.result()` inside a fiber _is_ the await
  point — the parking is invisible to the reader, which is the point. See
  [Why no `await`](#why-no-await) below.
- **`Thread` and `Fiber` are the same shape**: `X(fn(args)).start()` →
  `Task<T>`. Either can be passed to generic helpers, and both satisfy
  `Awaitable`.
- `main`'s `.result()` calls happen on a raw worker thread, so they block —
  identical to today's `t.wait()`. Parking only exists where a fiber is
  running, decided at runtime by `Runtime.current()`, not by types.
- The nursery (`async { }`) is untouched: it joins `Task<T>` handles at scope
  exit, and a `Fiber`'s handle is a `Task<T>`. Race mode, timeouts, and the
  named-nursery escape hatch work for fibers unchanged — they all poll the
  same future's done flag. The escape hatch becomes
  `pool.start(Thread(parse(conn)))` — one verb (`start`), two nouns.

### What the nursery does and doesn't do

**`start()` creates concurrency; `async { }` bounds it.** The block adds no
speed. Remove the wrapper from the after example and the timeline is nearly
identical: `fetch_pair`'s two fetches are concurrent with each other
regardless (they're fibers started inside it), and `crunch` overlaps because
it was started before main blocked on `io.result()`. The only thing main does
differently is wait without a receipt. The sum-of-latencies behavior belongs
to the _before_ code — plain calls, no started tasks at all.

What the wrapper buys is guarantees, not speed:

1. **Join at scope exit** — every exit path (return, panic unwind) joins
   first. Without it, a dropped handle is fire-and-forget until the
   process-exit drain: no correctness hole, but no prompt shutdown.
2. **Timeouts, race mode, cancellation scopes** — nursery features; a bare
   `start()` gets none of them.
3. **The soundness contract** letting tasks hold pointers to block-scoped
   locals (channels, buffers) — only true because the nursery provably
   outlives its tasks.

The TS analogy, made precise: **`.result()` is Nomen's `await`, and it is
always present when you want the value** — no call's meaning changes based on
context. The TS floating-promise bug maps not to "removed the `async { }`"
but to "_removed the `.result()`_" — a handle started and never touched. Even
that is softer than TS: the process-exit drain still joins it (a late
shutdown, not an unhandled rejection). The block's real analog is **`await
Promise.all(...)` implied at the closing brace** over everything started
inside, including dropped handles — TS has no such construct (lose the
reference, lose the join); the actual matches are Kotlin's
`coroutineScope { }` and Trio's nursery.

|                        | consumes results (`result()`) | never touches the handle                                                |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| **inside `async { }`** | explicit joins + safety net   | `await Promise.all` at the brace — values unused, completion guaranteed |
| **no `async { }`**     | same timeline, no safety net  | TS's missing-`await` bug, minus the crash                               |

### Why no `await`

In TS, `await` is load-bearing: it _is_ the join mechanism, and forgetting it
loses the value. Nomen's joins are `.result()`/`.wait()` when a value is
consumed and the block exit always — correctness is structural. An `await`
keyword here would carry no correctness weight; it would be purely
decorative, and a decorative `await` actively misleads:

- **It under-promises.** Parking happens inside blocking calls —
  `Mutex.lock()`, `Channel.receive()`, `Http.get()` — not at keyword sites. A
  keyword that says "suspension happens HERE" invites the belief that it
  happens _only_ here.
- **Enforcement is coloring in disguise.** Making `await` mandatory for
  park-capable calls requires statically proving park-capability — a
  reachability analysis that hits FFI walls and turns into annotations
  everywhere.
- **"Only inside `async { }`" is the wrong scope.** Parking is a _runtime_
  property (am I a fiber?), not a lexical one. The nursery body runs on a
  worker thread, so `mutex.lock()` inside the block _blocks and never parks_,
  while the real parking hides two frames deep inside `fetch_pair` — outside
  any block lexically. Enforcement would flag the wrong calls, miss the right
  ones, and sell a stronger false guarantee ("if it compiles, I've seen every
  suspension point").

What serves the underlying need ("show me where things rejoin") instead:

- `.result()` / `.wait()` already _read_ as waits — the blocking methods are
  named like blocking methods.
- The nursery guarantees rejoins at scope exit, unconditionally.
- The parking-reachability lint (Phase 4) can underline park-capable calls in
  the editor — a signal that tracks reality instead of a keyword that
  declares intent and rots.

`await` stays on the shelf as optional sugar (`await ra` ≡ `ra.result()`,
valid only on an `Awaitable`) if grep-ability is ever genuinely missed.

### Documenting "this parks"

Since any function can run on either model, an `async func` marker would be
advisory-only metadata — it can't affect checking without reintroducing
coloring, and advisory syntax rots. Instead:

- **Now**: a prose convention in the function's header comment ("parks on
  socket reads; good Fiber fit"), the way stdlib module docs already
  describe behavior.
- **Later, better**: a lint that computes it mechanically — scope it to
  **fiber-reachable code** (the correct "we care" region: functions
  transitively callable from a `Fiber(...).start()`), not to `async { }`
  blocks, and flag calls transitively reachable from `wait_for_io`-backed
  primitives. Compiler-checked documentation; if the hint proves valuable it
  graduates to an attribute, never a keyword.

### Naming

- **The keyword stays `async { }`.** The misleading part of `async` in other
  languages is `async fn` — coloring — and Nomen has no async functions and
  never will. In block position the word is accurate: it names the region
  whose exit is decoupled from its last statement, joined instead. It is also
  already in the reserved-words list (free, versus `join`/`scoped`, which
  would be _new_ reserved words breaking existing identifiers) and is the
  structured-concurrency search term.
- **The concept is an "async block" in user-facing docs.** "Nursery" is
  Trio's jargon and stays in design docs (ASYNC.md, this file), where the
  lineage matters.
- **Rejected**: `await { }` — the most colored word in the industry; using it
  for a scope imports the connotation the whole plan argues against and
  forecloses `await expr` sugar. `spawn { }` — a muscle-memory foot-gun: the
  removed keyword `spawn fn(args)` meant fire-and-forget, so `spawn {
fetch_user(1) }` reads as fire-and-forget but executes inline with zero
  concurrency — a silent semantics gap; also the wrong direction (`spawn` is
  the spigot word; the block is the dam). The honest rename would be
  `join { }`, kept on the shelf with its new-reserved-word cost noted.
- **`Fiber`, not `Routine`.** Names should survive the google test. "Routine"
  collides with its long-standing synonym _subroutine_ — `Routine(fn())
.start()` can misread as "wrap this in a procedure." "Fiber" is the
  canonical term for exactly this construct (Win32 fibers, Boost.Fiber, JVM
  Loom's original name): stackful, lightweight, cooperatively scheduled — a
  newbie's search lands on the right concept with the right properties.
- **Shipped vocabulary**: `Thread` / `Fiber` / `Task<T>` / `.start()` /
  `async { }` — two nouns, one verb method, one boundary keyword. Each does
  one job; nothing overlaps.

### Nested async blocks

Nurseries nest exactly like block scopes, because they _are_ block scopes —
this is structured concurrency's selling point and the reason a library can
honestly advertise "guaranteed cleanup":

```
// library — its cleanup guarantee is self-contained
func load_feed = (uint64 user, out Feed) {
    async {
        Thread(fetch_posts(user)).start()
        Thread(fetch_likes(user)).start()
        // joined here, unconditionally, before load_feed returns
    }
}

// UI — calls it from inside its own nursery
func render = (uint64 user) {
    async(timeout: 1000) {
        const feed = load_feed(user)   // inner async block already fully joined
        draw(feed)
    }
}
```

The outer join waits for `load_feed` to return; `load_feed` returning
_implies_ its inner join already happened. Each async block outlives exactly
its own tasks, cleanup runs innermost-first, and neither block needs to know
the other exists. The guarantees compose — that is what "structured" means.

Mechanics per case:

- **Fibers nesting** — trivial: a fiber waiting at an inner join _parks_,
  freeing its worker. No deadlock possible.
- **Threads nesting** — a worker blocked at an inner join is busy, so the
  pool grows on demand (up to 64): the "nested spawns can't deadlock"
  property ASYNC.md already ships.
- **Cancellation** — propagates cooperatively down the task tree: an outer
  timeout sets cancel flags on its children; inner tasks observe them at
  their checkpoints, and the inner join still runs before the block exits.
  Honest cost: joins are unconditional, so an outer timeout cannot hard-kill
  its way past a slow inner join — guarantees again over teardown speed.
- **One rule**: nesting is free; _crossing_ boundaries is what costs syntax —
  spawning into your _caller's_ block requires the explicit `ref Nursery`
  capability, so a library can never silently leak tasks into someone else's
  scope.

## Choosing Thread vs Fiber

The axis is not heavy-vs-light work; it is **CPU-hogging-or-blocking vs
waiting**:

- **Thread**: CPU-bound work (codecs, crypto, big loops), blocking FFI with
  no non-blocking path, anything that must not be starved by the scheduler.
- **Fiber**: many, mostly-idle, or I/O-bound tasks — connections, actors,
  fan-out.

The one foot-gun: a fiber that computes for milliseconds without parking
starves its cooperative siblings on that worker (no preemption). "Heavy" in
_memory_ terms is fine for a fiber — an 8 KB stack can point at gigabytes —
it's long _compute_ that disqualifies it. That is exactly what the Thread
escape hatch is for.

## Embedded

Rust's "runs on embedded" advantage comes from state machines needing no
allocator and no threads. Stackful fibers get most of the way there:

- **No TLS needed** — single-threaded targets make `Runtime.current()` a
  plain global.
- **No heap needed** — `start_on(stack_buffer)` runs a fiber on
  caller-provided static storage; `make_context` doesn't care where the stack
  came from.
- **No netpoller needed** — peripheral interrupt handlers wake parked
  fibers directly (the embassy/RTOS model, done stackful).
- **`CooperativeRuntime`** — the run loop _is_ the scheduler: pick a runnable
  fiber, switch to it, return when it parks. No preemption required on a
  single core; interrupt safety is the usual mask-around-switch discipline.

The thread model (`Thread`) is simply unavailable on these targets — no
pthreads — which is fine: embedded concurrency is fiber concurrency.

## Why this fits Nomen specifically

The "heavy runtime" cost of Go's model is mostly costs Nomen doesn't have:

- **No tracing GC → no stack scanning.** Parked stacks are ordinary heap data
  holding ordinary refcounted values. Go needs goroutine stack scanning for its
  GC; Nomen needs nothing.
- **RAII teardown.** Killing a parked coroutine (nursery cancel, race-mode
  loser) leaks its in-flight locals unless destructors run. Nomen's `#destroy`
  is scope-tied: push a "kill trampoline" frame onto the parked stack, switch
  to it, and the normal scope-exit teardown runs for every live frame. The
  nursery already cancels + joins at exit; fibers just get woken to run
  their cleanup instead of polling a flag.
- **`mov` ownership and `Sendable` are unchanged** — a value handed to
  `Fiber(fn(v)).start()` obeys the same rules as one handed to a `Thread`.
- **The future/join/nursery machinery already exists.** A fiber is a
  different way to _run_ a trampoline (on a switched stack instead of a
  borrowed thread), not a new concurrency concept.

## Phases

0. **`spawn` → `Thread` rename.** Independent of everything else; can land
   first. Keyword removed from the reserved list, `Thread` class added,
   SPEC/tests/docs updated. _Acceptance: all existing concurrency tests green
   with the new form._ **Status: landed.**
1. **Primitive + ambient runtime.** `switch_context`/`make_context` (aarch64
   asm), `Runtime` trait + `Runtime.current()` (TLS → fiber-local),
   `Fiber` class with fixed 64 KB stacks, `WorkerRuntime` multiplexing over
   the worker pool, `start_on` static stacks, `CooperativeRuntime`.
   _Acceptance: a `Fiber`-running `fetch_pair`-style program with
   `Task.wait`-style sleeps interleaves; existing thread tests untouched; a
   no-thread build runs a fiber on a static stack._ **Status: landed.** The
   context switch is ucontext on the C backend and a naked-asm register switch
   (x19–x28/FP/LR/SP) in the aarch64 companion; `Runtime.current()` is the
   `__nomen_current_fiber` thread-local; pool workers drain the fiber queue
   between pool tasks; `Task.result`/`wait` park a fiber (park-before-signal
   under the future's mutex, wakers requeue it on completion); cooperative
   mode runs fibers at would-block waits and process exit without starting
   threads. `start_on` is implemented on the C backend only — the aarch64
   backend cannot address locals past frame offset 4095, which any >= 16 KB
   buffer trips (pre-existing; see FOLLOWUP.md). Test coverage:
   `test/fiber.test.ts`.
2. **Park-aware blocking.** `Task.result`/`wait`, `Channel.receive`,
   `Mutex.lock` consult `Runtime.current()` and park instead of blocking.
   Kill-trampoline teardown on nursery cancel. _Acceptance: nested fibers,
   race mode, and timeout cancellation all work with fibers._ **Status:
   landed** — `Task.result`/`wait` park on the future (Phase 1);
   `Channel.receive`/`receive_string` park on a per-channel wait list
   (park-before-signal under the channel's mutex, `send` wakes receivers,
   idempotent scheduling via a state guard, a cancelled waiter returns the
   zero value). Cancellation reaches parked fibers: `__nomen_future_cancel`
   wakes future waiters and schedules the owning fiber (linked at spawn), and
   `run_here` restores the fiber's task-local cancel flag on every resume.
   `__nomen_future_timedwait` now builds a true absolute deadline (it
   previously treated the duration as one, so the "wait for cancelled tasks"
   step returned immediately). `Mutex.lock` parks cooperatively (try-lock +
   yield); the threaded model still blocks its worker — deferred, see
   FOLLOWUP.md. Forced-unwind kill-trampoline teardown is also deferred
   (cooperative observation is in place); see FOLLOWUP.md. Test coverage:
   `test/fiber_phase2.test.ts`.
3. **Async I/O.** Netpoller (kqueue/epoll), non-blocking socket stdlib
   (`Tcp`, `Http`) through `wait_for_io`. _Acceptance: 10k concurrent
   connections on ~4 workers._ **Status: landed** — the netpoller runtime
   (`__nomen_io_wait`: lazily started poller thread on kqueue/epoll, one
   persistent waiter slot per fd, the fiber parked and woken on socket
   readiness, plain `poll()` off-fiber, tore down before the audit check) and
   `core/System/Stream/Tcp.nm` (non-blocking listen/accept/connect/send/
   recv/recv_all/close, every wait through the hook) are shipped, with
   single-connection echo and connect-refused tests green on both backends.
   `Http` is now pure Nomen over `Tcp` (the blocking raw-asm bodies are
   gone): URL parse, request build, send, `recv_until_close`, and status/
   body split all ride the netpoller, so an `Http.get` inside a fiber parks
   instead of blocking its worker. Loopback get/post tests cover the success
   path (`test/http.test.ts`); the N = 64 concurrent-connection scale test
   passes (`test/tcp.test.ts`). The nursery's futures list is growable
   (realloc-doubling from 16; empty nurseries allocate nothing) — the old
   65536-entry cap and 512 KB per-block allocation are gone. Windows (IOCP +
   x86-64 `switch_context`) remains scoped as its own follow-on.
   Remaining scale headroom: the 10k-connection acceptance run hasn't been
   attempted yet; N = 64 is the tested ceiling.
4. **Scale + ergonomics, on demand.** Smaller initial stacks (8 KB) with
   growth (guard page + handler, or compiler-inserted stack-limit checks — the
   one future compiler engagement), `await` sugar, additional `Runtime`
   implementations (io_uring backend), parking-reachability lint scoped to
   fiber-reachable code.

## Costs and open questions

- **Stack sizing is the scale lever.** 64 KB fixed stacks ≈ 16k tasks/GB;
  millions of tasks need Phase 4 growth. Decide: guard-page SIGSEGV handling
  (library-only, hairy) vs stack-limit checks on function entry (small
  codegen change, needs a Nomen flag day).
- **FFI reentry.** An `extern` C callback that calls back into Nomen needs a
  fiber context (switch-in, or run the callback on a fresh fiber). Go's
  cgo problem; document early, solve in Phase 2.
- **C backend path.** Fibers land aarch64-first. The C backend starts with
  `ucontext`-based switching (slow but portable) or pthreads-only fallback;
  per-target asm follows the existing dual-backend pattern.
- **Windows** — x86-64 `switch_context` backend plus an IOCP-shaped
  `wait_for_io` implementation (or wepoll shim). Scoped as its own follow-on,
  not a Phase 3 blocker.
- **"Everything can park" is untyped** — same trade as Go. Any call may park;
  nothing in the type system says so. Mitigated by the header-comment
  convention now and the parking-reachability lint later; if it ever needs to
  be _typed_, that is the effect-system conversation (below), not a reason to
  color functions now.
- **Debugging/profiling** — N backtrace-per-fiber tooling, scheduler
  visibility. Real work; Go spent a decade here. Start with a
  `Fiber.dump_all()` debug aid.
- **Scheduler policy** — single run queue first (simple, adequate); work
  stealing only if benchmarks demand it.

## Relationship to effect handlers

Unchanged from ASYNC.md: an effect system is a large language feature and is
not planned. Note the convergence though — OCaml 5's effect handlers are
_implemented as_ stack switching (fibers). Shipping `switch_context` quietly
makes handlers a possible _library/stdlib_ feature later, without committing
to effect rows in the type system. effect.ts exists to emulate handlers in
languages with no substrate; Nomen would own the substrate directly.

## What does not change

`async { }` nurseries, `Sendable`, `Task<T>`, `Channel`, `Mutex`, cancellation
scopes, race mode, the `Nursery` escape hatch, no function coloring, ambient
cancellation. The one planned break is `spawn` → `Thread` (Phase 0) — a
rename, not a semantic change; the spawned-call, handle, and nursery-tracking
semantics are identical. SPEC's Concurrency section gains `Thread`/`Fiber`
subsections; every rule in them is an extension of the existing ones.
