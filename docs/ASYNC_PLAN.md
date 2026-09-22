# ASYNC_PLAN — plain spawn classes, trait-provided, no name magic

A design proposal from a language-design review of the concurrency surface.
Thesis: the spawn machinery works, but it is expressed as **compiler magic
keyed on library type names** (`"Thread"`, `"Fiber"`, `"Nursery"`, …). Nomen
already removed magic for `extern` and closures; the same standard should
apply here. `Thread`/`Fiber` should be plain classes whose methods are plain
functions, with functionality provided by traits — and the one genuinely
irreducible special form (the deferred call) should be explicitly marked, the
way `#init`/`#destroy` are.

The property this design protects:

> **The compiler may know a construct is special; it must not know a library
> type's name. Special forms are spelled with a marker the user can see.**

## Where we are today

The user-facing surface (SPEC.md §Concurrency, docs/ASYNC.md):

- `Thread(fn(args)).start()` / `.detach()` — a task on the shared worker pool
  (a daemon runs on its own detached pthread).
- `Fiber(fn(args)).start()` / `.start_on(buf)` — a stackful coroutine over the
  same pool; a waiting fiber parks instead of blocking its worker.
- `async { }` / `async(timeout: N)` / `async(mode: race)` — nurseries.
- `async pool { }` + `pool.start(Thread(fn(args)))` — the escape hatch.
- `Task<T>` — the handle returned by `.start()`: `wait`/`result`/`cancel`.
- `Awaitable` — `func wait = (ref self)`; `Task<T>` conforms.
- `Sendable` — marker trait, enforced on spawn arguments.

None of `Thread`/`Fiber`'s launch methods exist in the library source. They are
recognized by **name** in the checker and emitter:

| Site                                                   | What it matches on                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `src/check/check_function_call_node.ts:83-91`          | `node.name === "Thread" / "Fiber"` — the construction sugar                                         |
| `src/check/check_function_call_node.ts:1441-1457`      | `receiver_type === "Nursery" / "Thread" / "Fiber"` — `.start`/`.detach`/`.start_on`                 |
| `src/check/check_access_node.ts:447-467`               | the same dispatch                                                                                   |
| `src/build_c/build_magic_ctor.ts:39-41`                | `spawn_ctor_class_name` returns `"Thread"`/`"Fiber"`                                                |
| `src/build_c/build_struct_node.ts:43-51`               | `CONCURRENCY_TYPES = {Task, Thread, Fiber, Channel, Mutex, Nursery, Tcp}` — forces runtime emission |
| `src/build_aarch64/build_struct_node.ts:203`           | `node.name === "Fiber" \|\| "Thread"` — the same                                                    |
| `src/build_c/build_access_node.ts:550`, aarch64 `:648` | `Fiber.yield`/`is_fiber`/`set_cooperative` static calls                                             |
| `src/parse.ts:244-252`                                 | token scan for `Thread`/`Fiber`/`async` → injects `Task`/`Sendable`/`Nursery` imports               |

Two consequences:

1. **The API is invisible in the library.** `Thread.nm` declares only fields and
   `#destroy`; `.start()` (whose return type `Task<T>` is compiler-stamped)
   cannot be found by reading the class. "Where does the OS thread get
   created?" has no answer in Nomen source: `.start()` emits
   `__nomen_pool_submit(_closure)` (`src/build_c/build_spawn_node.ts:1296`),
   which lazily `pthread_create`s the pool (`:306`, `:311`).
2. **The generalized sugar is weak.** Any class conforming to `Awaitable` with
   the four-field contract gets `X(fn(args))`
   (`src/check/utils/awaitable_spawn_class.ts`). But the sugar always allocates
   a future, result slot, and cancel flag and packs a pool-bound closure — so a
   user primitive can only be a re-skin of `Thread` (the SPEC `Job` example).
   It cannot express a genuinely different primitive. A `Poll`-style class that
   does something else needs none of it: it is an ordinary class conforming to
   `Awaitable`, and it works today. It is dropped (Decisions).

### The one special form

`Thread(fn(args))` is a **special form**: the argument is an _unevaluated
call_. The compiler resolves `fn`, evaluates and packs its arguments eagerly,
and defers the call (`src/check/check_function_call_node.ts:1580`). A closure
form also exists — `Thread(() => fn(args))`, the lambda's captures become the
eager arguments (`:1664`, `src/build_c/build_magic_ctor.ts:381`) — with
different evaluation timing and ownership (below).

This special form is the only part that genuinely requires compiler support.
Everything else (`.start`, `.detach`, nursery registration) is expressed as
name dispatch because it was convenient, not because it is irreducible.

## Proposed direction

1. **Plain classes.** `Thread<T>` and `Fiber<T>` declare their own methods
   (`start`, `detach`, `start_on`, `#destroy`; `wait`/`result` live on the
   returned `Task<T>`) with real bodies over the existing library seam
   (`Task.pool_submit`, `future_wait`, `future_result_uint64`,
   `future_set_refs`, `future_release` — already the documented boundary for
   user primitives). No compiler method resolution by name.

2. **Functionality via traits** (the C# shape). `Task<T>` is the handle
   (decision below), so `start` returns it and the spawn class carries only the
   `Spawnable` role:

   ```nomen
   pub trait Sendable { }                      // marker (exists)

   pub trait Spawnable<T> {
       func start = (ref self, out Task<T>)    // returns the awaitable handle
       func detach = (ref self)                // daemon; statement only
   }

   pub trait Awaitable {
       func wait = (ref self)                  // consumption (exists)
   }

   pub class Thread<T> : Sendable, Spawnable<T> { … }
   pub class Fiber<T> : Sendable, Spawnable<T> { … }
   pub class Task<T> : Sendable, Awaitable { … }
   ```

   Keeping `Task<T>` as the returned handle means a spawn class implements only
   `Spawnable`; the await surface is guaranteed by the return type (the
   library-owned `Task<T>` always conforms to `Awaitable`), so an author cannot
   forget the consumption half. Each type then carries one role: `Thread<T>` is
   spawnable, `Task<T>` is awaitable. Generic code can `start` any
   `Spawnable<T>` and `wait` on any `Awaitable`; `result(move out T)` lives on
   `Task<T>` because only it knows `T`. `Spawnable` is generic because its
   return type mentions `T`; `Awaitable` stays non-generic (`wait` does not).

3. **An ambient current-task context (cancel flag only).** The precedent
   already exists: `__nomen_current_cancel_flag` is a `__thread` pointer
   (`src/build_c/build_spawn_node.ts:67`) that the trampoline sets on entry
   (`src/build_c/build_magic_ctor.ts:223`) and the fiber runner **restores on
   every resume** (`:609`) because a worker runs many tasks.
   `Task.current_cancelled()` just reads it. Keep it, and bundle the per-task
   ambient state so there is a single save/restore point.

   Nursery registration goes neither ambient nor call-site: the nursery is
   captured where it is already known — at the `#spawn` construction, which is
   the special form — and stored in the instance. `.start()` reads the stored
   tracking slots and registers, so it is an ordinary method (correct even
   through a `Spawnable<T>`-typed or otherwise indirect receiver). See
   Decisions, "Lexical at construction."

4. **The `#spawn` constructor marker.** A `Spawnable` class declares its
   construction hook as `#spawn` instead of `#init`; the marker says the single
   argument is a _deferred unit of work_ — a call (args packed eagerly, call
   later) or a zero-arg function value — never an ordinary value. That is the
   one special form, now opt-in and visible, joining `#init`/`#destroy` as a
   lifecycle marker; the compiler matches the `#spawn` member, never
   `"Thread"`. See "The `#spawn` constructor" below.

5. **`Sendable` shrinks to "safe to share."** Today it is a type-based check on
   every spawn argument and capture — over-broad (it rejects a `move`d value
   whose ownership is already exclusive) and inconsistent (the nursery-borrow
   path bypasses it for the very shared-class case it guards). It should gate
   only _shared_ class/trait references crossing the boundary; owned and copied
   values are exempt. See "What `Sendable` is for" below.

6. **Runtime dependency via a linked companion.** Replace `CONCURRENCY_TYPES`
   and the aarch64 `Fiber`/`Thread` name checks by shipping the concurrency
   runtime in the System library's companion C (the way `aarch64_use_c` bodies
   already ship), so link/emission is the library's concern and no
   per-type-name logic remains.

## The `#spawn` constructor

The call form is **kept** (see below); it gets an explicit marker instead of a
name. A `Spawnable` class declares its construction hook as `#spawn`, and the
compiler treats `X(...)` on a `#spawn`-bearing class as the deferred-call
special form:

```nomen
pub class Thread<T> : Spawnable<T> {
    #spawn                           // single arg: a call or a zero-arg func value
    pub func start = (ref self) { … }
    pub func detach = (ref self) { … }
    pub func #destroy = () { … }
}
```

**Decided:** a `#spawn` constructor's single argument is either a _deferred
call_ (`Thread(work(n))` — args evaluated and packed eagerly, call deferred) or
a _zero-arg function value_ (`Thread(() => work(n))`, or a func-typed local).
The compiler selects by **syntax**, not by overload: the call form's argument is
not a value, so there is no type for overload resolution to match — which of the
two it is follows from whether the argument node is a call expression or a func
value. Overloading `#spawn` is therefore not the mechanism.

`#spawn` declares no ordinary parameters: the wrapped call's argument list is
opaque to the class and its return type is the class's `T`. Everything else
mirrors `#init`: discoverable in the library source, and required for
construction (`Spawnable<T>` can require it — the C# 11 static-abstract-member
analog).

**Argument forms (decided).** The single argument must be a call expression or a
zero-arg function value. Anything else — a plain value, or a lambda with
parameters — is a compile error, anchored at the argument:
`` `#spawn` expects a call or a zero-argument function value (bind arguments in the lambda's captures) ``.

## Why not closure-only (decided)

Forcing closures would delete the special form entirely — `Thread(() => work(n))`
is an ordinary constructor call on a class whose `#init` takes `func (out T)`,
and the only remaining compiler involvement is emitting the runtime. We are
**not** taking that path: the call form is kept. The costs the closure form
cannot recover are why:

- **Eager argument evaluation.** `Thread(fetch(next_id()))` evaluates
  `next_id()` at the spawn site and packs it; `Thread(() => fetch(next_id()))`
  runs it on the task. A bare variable is equivalent (it is a capture,
  snapshotted eagerly), but any argument _expression_ must be hoisted:
  `const x = next_id(); Thread(() => fetch(x))`. This is why Go's `go f(x)`
  is eager; Rust/C#/Swift chose closures and live with the hoisting.
- **The nursery-borrow exception.** A non-Sendable class arg may be passed as a
  borrow inside `async { }`; closure captures are _move_ captures
  (CLOSURE.md Phase 2c), so `Thread(() => work(counter))` would move `counter`.
- **Clean string-result ownership.** The direct-call trampoline calls the
  function and stores the result with no aliasing question; the closure path
  must reason about whether a returned string aliases the closure env (below).

The closure form stays as a secondary spelling (`Thread(() => work(n))`), as it
is today — see the `#spawn` section for why both forms exist and why overloads
are not the selection mechanism. What closure-only would have bought — deleting
the unevaluated-call form and its dual-path check/build code
(`is_func_value_ctor` vs call form) — is paid for by the `#spawn` marker, which
makes the form explicit without removing it.

### The generalized `Awaitable` sugar is dropped

**Decided.** The generalized construction sugar (`X(fn(args))` for any
`Awaitable`-conforming class carrying the four-field contract) is removed;
`Thread`/`Fiber` keep the `#spawn` construction. Reasons: its contract is a
compile-time field layout, not an interface (invisible coupling the rest of the
plan removes); its only example re-derives `Thread`; and the plausible use case
— policy wrappers — is served by a plain class conforming to `Awaitable` over a
`Thread`. Extension points become `Spawnable<T>` (start) and `Awaitable`
(consume). `SPAWN_FIELD_CONTRACT` / `resolve_awaitable_spawn_class` are retired,
and the SPEC "User-defined async primitives" section is removed. _Path not
taken:_ keep it and re-motivate with a real wrapper example. Downside accepted:
a user primitive can no longer use the magic construction spelling or be passed
to a nursery's `.start(...)` / `.detach()`; a `Spawnable<T>`-conforming class
can still be `.start()`ed explicitly.

## What `Sendable` is for

`Sendable` should shrink to exactly the case it protects. Classify what crosses
a task boundary:

| Crossing value                           | Sharing     | `Sendable` needed? |
| ---------------------------------------- | ----------- | ------------------ |
| moved (`move` param / move-capture)      | exclusive   | no                 |
| copied (string deep-copy, owning struct) | independent | no                 |
| shared class/trait reference (plain arg) | **shared**  | **yes**            |
| nursery borrow (non-Sendable class)      | **shared**  | **yes** (retired)  |

Only the shared-reference cases race, and `Sendable` is the opt-in that says
"this class is safe to share across a task boundary" — the marker shared
`Channel`/`Mutex` need. It is required only there: a `move`d non-Sendable class
is exempt (ownership is exclusive), and so is a copied value. The
nursery-borrow exception is retired (decision below), so a non-Sendable
class/trait can no longer cross into a task even as a borrow — mark it
`Sendable`, move it in, or share it through a `Sendable` primitive.

## The opaque-closure string leak

**Decided:** keep the documented leak for now; it is recorded in FOLLOWUP.md.
With the call form kept, this compromise only affects the optional closure form
(`Thread(() => …)`) and moved func-typed values, never a direct spawn. Today,
for a `string`-returning task (`src/build_c/build_magic_ctor.ts:395-429`,
aarch64 `:284-317`):

- **capture-free lambda literal** → transfer the result as-is.
- **capturing lambda literal** → alias-check the result against each captured
  string; `strdup` only if it aliases the env (balanced).
- **opaque closure** (a moved func-typed local, or a named function
  materialized as a thunk) → `nomen_str_dup` the result and **leak the
  original** (`:428`; docs/ASYNC.md:103 "leak-never-dangle, bounded at one per
  run").

There is no diagnostic for the opaque case. Possible future changes (not taken
now): extend the closure descriptor ABI to carry result ownership (so the
adapter can transfer vs duplicate exactly), or reject the opaque case with a
diagnostic (forcing a lambda literal whose captures the compiler can see).

## Migration phases

Each phase is independently landable; later ones assume earlier ones.

1. **`start`/`detach`/`start_on` as real methods.** ✅ **DONE** (branch
   `async`). `Thread.nm` declares `start` (returns `move out Task<T>` via a
   real **internal** `#init` on `Task<T>`) and `detach`; `Fiber.nm` declares
   `start` — raw `#arch: c`/`#arch: aarch64` bodies over the runtime seam,
   plus Nomen tail code that builds the Task through the internal `#init` and
   transfers the handles. Registration is **lexical-at-construction**: Thread/
   Fiber carry `nursery_futures`/`nursery_count`/`nursery_cap` capture fields
   that both backends' constructions fill from the enclosing async block's
   tracking slots, and `start` registers through the stored pointers (refs are
   uniform: 2, or 3 with a captured nursery — a discarded statement-form Task
   releases its share via the hoisted-temp destroy, as before). The Thread/
   Fiber name dispatch is gone from `check_access_node.ts` /
   `check_function_call_node.ts`, and the per-site `build_thread_start` /
   `build_thread_detach` / `build_fiber_spawn_node` emitters are deleted. Two
   deliberate exceptions remain, both recorded at their sites: the
   **nursery.start escape hatch** (its arg is the construction special form)
   and **`Fiber.start_on`'s compile-time stack-buffer validation** — the
   caller-buffer storage story does not exist yet (pre-existing: both
   backends already ran start_on fibers on heap stacks), so its checker
   validates the >= 16 KB fixed array and then rewrites the call to the
   ordinary `Fiber.start`. The chained-temp free moved into the receiver
   emission of both backends' method-call paths, keyed on the construction
   flags (never the name). The construction's Sendable borrow exception is
   recorded on the wrapped call (`spawned_borrow_args`) and the daemon launch
   rejects it, preserving the phase-3d diagnostic that used to live in the
   deleted `check_spawn_detach`.
2. **Traits.** ✅ **DONE**. `core/System/Spawnable.nm` declares
   `pub trait Spawnable<T>` (`func start = (ref self, move out Task<T>)`;
   `func detach = (ref self)` — both required); `Awaitable` stays as-is and
   non-generic. `Thread<T>`/`Fiber<T>` now declare `: Sendable, Spawnable<T>`;
   `Task<T>` already declared `: Sendable, Awaitable`. Fiber gains a `detach`
   (fire-and-forget: launch and drop the handle) so it satisfies the trait's
   required method. Compiler fix this surfaced: the monomorphizer dropped
   `trait_args` when cloning a generic struct, so `Thread_uint64`'s
   `Spawnable` conformance looked bare — trait args now ride the clone
   substituted (`Thread_uint64 : Spawnable_uint64`-shaped args).
3. **The `#spawn` marker.** ✅ **DONE**. `#spawn` parses as a lifecycle
   marker beside `#init`/`#destroy` (bare or `<visibility> #spawn` form; body
   is a declaration — both backends skip its emission, and declaring it
   suppresses the default `#init`, so a `#spawn` class is not ordinarily
   constructible). `Thread.nm`/`Fiber.nm` declare `#spawn`, and the special
   form keys on the member: the checker resolves the call's name to a
   declared struct and takes the deferred-call path iff that struct declares
   `#spawn` — the `node.name === "Thread"/"Fiber"` dispatch and its
   is_library/shadow guardrails are deleted (a user struct named `Thread`
   without `#spawn` shadows the sugar naturally; a user struct that declares
   its own `#spawn` gains it). A `#spawn`-bearing class constructed with a
   malformed argument — a plain value or a parameterized lambda — gets the
   dedicated error, anchored at the argument: `` `#spawn` expects a call or a
zero-argument function value (bind arguments in the lambda's captures) ``.
   Trait conformance skips `#spawn` as a lifecycle hook (not a contract
   method). SPEC's Thread section documents the marker.
4. **Drop the generalized `Awaitable` sugar.** ✅ **DONE**.
   `resolve_awaitable_spawn_class` / `SPAWN_FIELD_CONTRACT` /
   `spawn_field_contract_gaps` (`src/check/utils/awaitable_spawn_class.ts`)
   are deleted; the checker's Awaitable-conformance dispatch and the
   `resolve_free_calls_in_node` awaitable arm with them (both construction
   dispatch and mono re-derivation key on the `#spawn` member). The SPEC
   "User-defined async primitives" section is removed along with its spec
   block tests; `test/awaitable_ctor.test.ts` is deleted. `is_awaitable_ctor`
   survives only as the below-checker flavor stamp for a `#spawn`-bearing
   class that is neither Thread nor Fiber (a user class declaring its own
   hook — still member-keyed, per phase 3).
5. **Shrink `Sendable`.** ✅ **DONE**. `validate_spawn_args_sendable` now
   gates exactly the shared case: a class/trait reference passed as a plain
   argument (the packed env aliases the instance) must be `Sendable`.
   Exemptions: moved arguments (the wrapped callee's `move T` parameter
   takes exclusive ownership) and copied values (scalars/strings deep-copy
   at pack; owning value structs are env-copied, with `is_sendable_type`'s
   field recursion still rejecting a struct holding an unsafe class field).
   The nursery-borrow path (`allow_borrows`, the donor/distinguishing
   errors, and the `spawned_borrow_args` daemon diagnostic from phase 1) is
   retired. SPEC's Sendable section and docs/ASYNC.md describe the shrunk
   rule; the phase-3d spawn-env tests and the SPEC nursery-escape-hatch
   tests now assert rejection inside nurseries and the `move` exemption.
6. **Runtime dependency + parse auto-imports.** ✅ **DONE** (one deliberate
   mechanism deviation, below). The per-type-name gates are gone:
   `CONCURRENCY_TYPES` (C `build_struct_node`), the aarch64
   `Fiber || Thread` check, and the `receiver === "Fiber"` static-call
   checks in both access builders are replaced by a content scan —
   `ensure_runtime_for_method` / `ensure_runtime_for_method_a64` walk a
   struct's method bodies (including `#destroy`) and pull the runtime in
   when any raw `#arch` body references `__nomen_*` symbols, so the runtime
   dependency belongs to the library code itself. Both `async` block
   builders now pull the runtime unconditionally (their join loops reference
   the future helpers whether or not a spawn occurs). The parse token scan
   is reduced to its one irreducible case — `async` implies `Nursery` (the
   capability is bound by compiler syntax, invisible to the type-token scan)
   — and the `Thread`/`Fiber` → Task+Sendable special case is replaced by
   explicit declared dependencies: `import Task` in Thread.nm/Fiber.nm rides
   the existing `extract_deps` mechanism (their Sendable/Spawnable
   conformance deps were already extracted from the class line).
   _Deviation:_ the plan sketched shipping the runtime text in the library's
   companion C file; instead the runtime stays compiler-emitted but keyed on
   library-body content, which achieves the stated goal — link/emission is
   the library's concern and no per-type-name logic remains — without
   moving the runtime text out of `build_spawn_node`.

**Branching.** Do the whole arc on a branch (not `main`) — it touches parse,
check, both backends, and the runtime together, and the existing runtime tests
(`test/task.test.ts`, `test/fiber*.test.ts`, `test/awaitable*.test.ts`,
`test/fn_value_spawn.test.ts`, `test/spec/concurrency.test.ts`,
`test/readme/concurrency.test.ts`, `test/tcp.test.ts`, `test/deadlock.test.ts`)
are the guardrail. Keep the old name-dispatch paths until the last phase of the
branch so there is a green intermediate state at each phase.

## Decisions (with paths not taken)

- **Keep `Task<T>` as the returned handle; `start` yields it (`Spawnable<T>`).**
  A spawn class implements only `Spawnable<T>`; `Task<T>` supplies `Awaitable`,
  so the consumption half cannot be forgotten and each type carries one role
  (`Thread<T>` is spawnable, `Task<T>` is awaitable). `Task<T>`'s `#init` stays
  **internal** so `start` can return it without users constructing bare handles.
  _Path not taken:_ the self-handle design (the `Job` shape) — `Thread<T>`
  implements both `Spawnable` and `Awaitable`, `.start()` returns void/`self`,
  one type, but it forces both roles onto one type and loses the guaranteed
  await surface.
- **Keep `Spawnable<T>` as a separate trait (not rolled into `Awaitable`; not
  dropped).** The two are duals — `Spawnable` produces an awaitable, `Awaitable`
  consumes — so merging them would force both roles onto every type (the
  self-handle mistake at the trait level). Keeping the trait also documents the
  required methods (`start`/`detach`) instead of relying on magic method names.
  `Awaitable` stays non-generic; `Spawnable<T>` is generic because `start`'s
  return type mentions `T`.
- **Lexical at construction (not at start, not dynamic).** The nursery is
  captured at the `#spawn` construction — the special form, where it is already
  known — and stored in the instance; `.start()` registers from the stored
  pointer, so `start` stays an ordinary method and is correct even when
  dispatched through a `Spawnable<T>`-typed or otherwise indirect receiver.
  The deferred call belongs to the scope that created it: a `Thread(f)` built
  outside an `async` block and started inside registers with the creation
  scope's nursery (none), not the start scope's. The explicit escape hatch
  (`pool.start(Thread(f))`) is unchanged — it registers through the passed
  `pool`. _Paths not taken:_ **_lexical at start_** — the compiler injects
  registration at the `.start()` call site; it breaks under trait dispatch
  (the compiler sees a `Spawnable<T>` method, not a concrete `Thread.start`, so
  the task silently escapes the nursery). **_Dynamic_** — an ambient current
  nursery read by `.start()`; mechanically plain but captures a helper's
  internal spawns and can turn a detached task into a joined one.
- **Require `Sendable` for shared references; retire the nursery borrow.** A
  non-Sendable class/trait can no longer cross into a task even as a
  join-bounded borrow. _Paths not taken:_ keep the borrow as an explicit
  unchecked convenience (a marker), or keep it silent. Functionality removed:
  exactly the nursery-borrow exception; the alternatives are to mark the class
  `Sendable`, move it in, or share it through a `Sendable` primitive
  (`Mutex`/`Channel`).
- **Keep the documented opaque-closure leak (not ABI ownership, not a
  diagnostic).** It only affects the optional closure form; recorded in
  FOLLOWUP.md. _Paths not taken:_ extend the closure descriptor ABI with result
  ownership, or reject the opaque case with a diagnostic.
- **Keep `Nursery.current()` internal (not exposed).** The current nursery is
  captured at construction and stored in the instance, so no ambient accessor is
  needed; the explicit `async pool {}` + `ref pool` escape hatch remains the
  user-facing way to spawn into a caller's nursery. _Path not taken:_ expose
  `Nursery.current()` as a capability — redundant once construction captures it,
  and it reintroduces an ambient grab.
- **Drop the generalized `Awaitable` sugar (not keep-and-re-motivate).** The
  `X(fn(args))` construction is removed for arbitrary `Awaitable` classes; only
  `Thread`/`Fiber` keep the `#spawn` construction. `.spawn`/`.start` sugar
  becomes a property of `Spawnable<T>`, not of a field contract. _Path not
  taken:_ keep it and re-motivate with a real policy-wrapper example. Downside
  accepted: a user `Spawnable<T>` class cannot use the magic construction
  spelling or be passed to `.detach()` / a nursery's `.start(...)`; it is
  `.start()`ed explicitly (`.detach` — decide whether it stays
  `Thread`-specific).
