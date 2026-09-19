# Closure Plan: Capturing Lambdas

Extends ASYNC_PLAN_2.md's analysis (the spawn constructor is the compiler
generating the closures the language doesn't have) into an actual language
feature. Phased; each phase lands with the full suite green.

## Goal

Lambdas that capture outer locals. The demand:

- **Callbacks with context** — every higher-order API today forces the
  context through parameters (the allmark port's "traits instead of func
  fields" workaround).
- **Bound-method values** — `obj.method` with a captured receiver.
- **The ASYNC_PLAN_2 payoff** — `Thread`/`Fiber` de-specialized into library
  structs over capturing lambdas; user-defined spawnables; `#destroy`-based
  must-start.

Today lambdas exist but captures are rejected ("Nested function cannot
capture outer local …; closures are not supported — pass it as a parameter",
`src/check/check_value_node.ts`). The one place the compiler builds an
environment is the spawn magic ctor's per-site trampoline — which is the
design template for everything below.

## Design

### Representation: closure descriptors, not fat values

ASYNC_PLAN_2 sketched fat `(code, env)` func values. That is an ABI flag day
on every func-typed signature (two slots per param, pair returns, every call
site shifted). The equivalent without the flag day: a func VALUE is a pointer
to a closure descriptor, and signatures never change.

```c
struct nomen_closure {
	void *code;   // the lowered lambda / function
	void *env;    // capture environment; NULL for capture-free
	int owned;    // 1 = heap descriptor owning env; 0 = static, never free
};
```

- **Signatures unchanged** — func-typed params, fields, locals, and returns
  stay one word (one register on aarch64; no arg-slot shifts, no pair ABI,
  no sret).
- **Indirect calls gain the env**: `ret = code(env, args…)`. Lambda
  definitions lower as `Ret _lambda_N(Env *env, Args…)`; capture-free
  lambdas and named functions used as values all take the same hidden first
  parameter (NULL for capture-free — uniform ABI, still real functions).
- **`owned` flag**: capture-free functions get STATIC descriptors (emitted
  once per function, never freed); capturing lambdas get heap descriptors
  that own their env. The runtime flag lets destroy paths free-or-not
  without static knowledge of what a func-typed variable holds.
- **Codegen cost**: two loads per indirect call. Nothing else.

### Captures: the env is an owning struct

A capture env is a compiler-generated owning struct — one field per captured
local — so every rule already shipped for owning structs applies unchanged.
No new soundness surface:

- **Non-owning scalars/structs: copied** into the env (capture = copy).
- **Strings: copied** (strdup at capture — the always-heap precedent from
  the value-struct string-field work); the local keeps its own.
- **Owning structs and classes: moved** — the donating local is invalidated
  by the existing use-after-move machinery, and the env owns and frees.
- **Borrow-captures: rejected** in this phase ("capture would create shared
  ownership" — the same rule family as borrowed values into owning
  parameters). The nursery-lifetime borrow-capture arrives with Phase 3's
  `Thread(fn(args))` sugar, which keeps its current borrow semantics until
  then.

A lambda body referencing an outer local captures it. Capture stamps: the
lambda's capture set (name, kind, type) on its FunctionNode; moved locals as
moved; the lambda expression as an OWNING VALUE when any capture is owning
(anchor + free like a heap string), non-owning otherwise.

### Move-only capturing values

Copying a capturing closure would share the env — double free. The checker
sees every RHS expression, so the rule is per-expression, not per-type:
assigning, passing, or returning a CAPTURING lambda moves it (the source is
invalidated); capture-free and named functions stay freely copyable (static
descriptor, nothing to free). Func-typed TYPES remain copyable in
signatures; only capturing VALUES are move-only.

### Free-if-owned destruction

- **func-typed locals**: at scope exit, `if (v && v->owned) { free(v->env);
free(v); }` — a new arm in both backends' scope-teardown/auto-free passes.
- **func-typed fields**: `#destroy` gains the same arm.
- **func-typed params**: the callee owns a moved-in capturing closure; the
  same arm frees at callee scope exit.
- **Containers of func types**: capturing lambdas are rejected as container
  elements in this phase (shared-ownership family); capture-free functions
  keep working as they do today. Owned-element storage is a follow-up.

### What this phase rejects (deferred, recorded)

- Borrow-captures (Phase 3, with the nursery sugar).
- Capturing lambdas stored in containers.
- Capture of a `ref` param (aliases; same shared-ownership family).

## Phases

**Phase 1 — uniform descriptor ABI (no captures yet).** Lambda lowering
gains the hidden env param (always NULL); every func-as-value site
materializes a static descriptor; every call-through loads code+env and
passes env first; raw `#arch: c` bodies that invoke func-typed params
(`modify_T` and friends) route through the descriptor ABI. Suite green; the
only codegen delta is the two loads per indirect call. _Gate: full suite,
both backends, byte-comparable outputs modulo the call sequences._

> **Status: LANDED.** All func-typed params/fields/locals/returns are one
> word; `struct nomen_closure { code, env, owned }` (C header-emitted once,
> `NOMEN_CLOSURE_STRUCT`-guarded for split builds; aarch64 stores descriptors
> as plain function-pointer tables in `__DATA` — text→text relocations are
> illegal on arm64 Mach-O — reached via `adrp`+`add`). Lambdas take the
> hidden env slot (direct calls to declaration-named lambdas pass NULL);
> named functions used as values get an auto-generated thunk that shifts the
> argument slots and tail-calls the unchanged original. Call-throughs
> (`is_func_param`, func-typed fields, `Buffer`/`ClassBuffer.modify` raw
> bodies on both backends) load `{ code, env }` and pass env first. The
> closure cast's signature prefers the enclosing function's parameter (its
> func signature is monomorphization-substituted) over the synthesized callee
> (which may still carry `T`). Green: the full func/lambda suite on both
> backends, plus the whole suite (one pre-existing timeout-margin flake in
> `emit_nir`'s corpus test: baseline also runs ~25s against a 30s limit).
> Nothing user-visible changed yet — no captures exist; `env` is always NULL.

**Phase 2 — captures.** Checker: capture analysis replaces the
`check_value_node` rejection (capture set, copy/move kinds, moved-local
stamps, owning-value anchoring, the rejection table above). Backends: env
struct emission per lambda, strdup/move capture prologue, free-if-owned arms
(locals, fields, params), static-vs-heap descriptors. Tests: capture smoke
per kind, move-only enforcement, audit-balanced frees, lambdas in generic
bodies (mono clones re-derive captures). SPEC's Anonymous Functions section
updated (+ test/spec).

> **Status: Phase 2a LANDED — scalar copy-captures.** A lambda may capture
> outer SCALARS by copy. `check_value_node` records captures on the enclosing
> closure's `FunctionNode.captures`; strings/owning structs/classes/traits/
> borrows/arrays/views/pointers/structs/nested closures are rejected with a
> specific message. A capturing lambda lowers to a heap env struct (one 8-byte
> field per capture, copied from the enclosing scope at materialization) plus a
> heap descriptor (`owned = 1`); the lambda body reads captures through the env
> (C: `_env->name`; aarch64: env pointer parked in a frame slot, `ldr` from
> `[env, #off]`). A capturing declaration-lambda holds the descriptor in its
> slot — the checker re-routes calls to it through the func-VALUE path (a direct
> call can't pass the env) — and the holder frees env+descriptor at scope exit
> via the descriptor's `owned` flag (capture-free closures point at static
> descriptors and are never freed). Tests: `test/lambda_capture.test.ts`
> (snapshot semantics, two captures, zero-arg `out` signature, rejections),
> audit-balanced on both backends; full suite green.
>
> **Status: Phase 2b LANDED — owned string captures.** A lambda may capture
> outer STRINGS; the value site deep-copies each with `nomen_str_dup` into the
> env (a 16-byte fat field), and the descriptor gains a fourth word
> `destroy_env` (`void (*)(void *)`) pointing at a per-lambda env destructor
> that frees the captured strings' ptr halves. The scope-exit free-if-owned arm
> calls `destroy_env` before freeing the env+descriptor. Capture validation
> moved into `type_from_value` (the value-resolution funnel), so every
> reference form is covered — plain reads, method receivers, assignment
> targets — not just `check_value_node`'s read path, which had missed
> receivers.
>
> **Status: Phase 2c (part 1) LANDED — value-struct captures.** A lambda may
> capture a NON-OWNING value struct by copy (snapshot semantics; mutation of
> the source afterwards is not seen). The env field differs per backend: C
> holds a POINTER to a malloc'd copy (the struct's full C definition lands in
> the code, after the headers the env typedef is emitted into, so an inline
> field would be an incomplete type) and the capture map reads it as
> `(*_env->p)`; aarch64 stores the struct's bytes INLINE in the env (offset
> layout by size) and reads the field's address. The env destructor frees the
> C pointer copy; aarch64's is a no-op for scalars/structs (no owned fields).
>
> **Status: Phase 2c (part 2) LANDED — move captures + nested closures.**
>
> - **Owning value structs** (`is_owning_struct_type_requiring_move`): captured
>   by MOVE. The env holds the struct's bytes (inline on aarch64, a malloc'd
>   byte-copy on C) and its `destroy_env` runs `<T>_destroy` (aarch64 against
>   the env field's address, C against the malloc'd copy) before freeing the
>   copy. The donating local is invalidated in the enclosing scope
>   (`check_function_node` adds move captures to `status.moved_variables`, so
>   a later use is a use-after-move error) and the backends skip its
>   scope-exit destroy (`status.moved` — C's `free_scoped_declarations` now
>   honours it, aarch64 already did).
> - **Class instances**: captured by MOVE (the env owns the instance pointer;
>   `destroy_env` runs `<Class>_destroy` + `free`). A borrowed (field/container
>   accessor) or aliased (`var Box b = a`) class reference is rejected — it is
>   not the closure's to own. A `move Box` PARAMETER is owned by the callee and
>   may be captured; `scan_moved_param_consumed` now treats a closure body that
>   references the param as consuming it, so the callee's param reclaim is
>   skipped and the env destructor owns it.
> - **Class-backed trait references**: captured by MOVE (the env owns the
>   pointer; `destroy_env` dispatches through the trait's `<Trait>_destroy`
>   shim + `free`). aarch64 registers the capture in `trait_class_frames` so
>   vtable dispatch dereferences the env field; C's `build_vtable_target`
>   emits the captured `_env->name` pointer directly. A VALUE-STRUCT trait slot
>   (inline conformer storage) is still rejected.
> - **Nested closures**: a func-valued local is captured by MOVE. A
>   func-valued StackValue from an `out`-returning signature carries the RETURN
>   type, so capture analysis detects func values structurally
>   (`func_params`/`func_return_type`) and records a normalized `func` type.
>   Calls to a captured func value route through the closure env on both
>   backends (C's `is_func_param` path and aarch64's descriptor reload consult
>   the capture map); the env's `destroy_env` uses the same owned-flag
>   free-if-owned arm as a func-typed local. The nested-capture reference is
>   recorded at the func-VALUE call resolver (not `type_from_value`), which had
>   bypassed the funnel.
> - **Move-on-assignment / storage**: a capturing closure is move-only. A
>   func-typed binding initialized from, or assigned, a capturing lambda or
>   another owning closure stamps the source value node `is_moved` and
>   invalidates it in `moved_variables`; the backends splice/`mark_moved` the
>   source and register the destination for the scope-exit free-if-owned arm.
>   A CLASS func-typed field is reclaimed by `<Class>_destroy` (free-if-owned);
>   a VALUE-struct func-typed field cannot own one (copies share the
>   descriptor), so storing a capturing closure there is rejected.
>
> Also fixed en route: `build_function_node` (aarch64) now isolates
> `heap_cleanup_stack` per function. Without it a lambda's return-path cleanup
> iterated the ENCLOSING function's heap anchor slots and freed them from
> inside the lambda (double-free of a class local captured — or merely live —
> around the lambda).
>
> **Deliberate restrictions (documented, not gaps)**: capturing a `ref`/`var`
> borrow, a view/array/pointer, a VALUE-STRUCT trait slot (inline conformer
> storage), a borrowed (non-`move`) class/trait/owning-struct parameter, or a
> func-typed PARAMETER (a borrow — the caller still owns the descriptor, so a
> closure that outlives the call would dangle; the pass-to-param posture stays
> a borrow). Containers/returns of func values are not expressible in the
> language (generic type args and `out` return types don't parse `func (...)`),
> so the shared-ownership container case is unreachable.

**Phase 3 — the ASYNC_PLAN_2 payoff (separate landing).** `Thread`/`Fiber`
de-specialized into library structs over capturing lambdas; the
`Thread(fn(args))` sugar keeps eager-arg borrow-captures inside nurseries
(scope-depth-expressible: the sugar only exists in `async { }`); `.detach()`
enforces owned captures; must-start via the library `#destroy` pattern; the
`Awaitable` construction side opens user-defined spawnables.

> **Status: Phase 3d LANDED — the spawn sugar's env is an OWNING struct,
> plus nursery borrows.** The hand-packed arg env gains a per-site
> destructor wired through the descriptor's `destroy_env` (every release
> path reclaims uniformly): fat `string` args are deep-copied at pack and
> freed by the destructor — a raw pair copy aliased the caller's buffer and
> dangled the moment the caller's scope exit ran. On C, an owning
> value-struct arg is a malloc'd COPY whose top-level string fields are
> strdup'd at pack, destroyed (`<T>_destroy`) and freed by the env
> destructor — the pre-3d byte copy aliased the donor's heap fields
> (rodata for a literal field) and `<T>_destroy` would free them
> invalidly; the callee ABI's pointer form (value-struct args arrive as
> `struct T *`) is now emitted correctly in the trampoline's forward
> declaration too (a pre-existing tag-less/`conflicting types` gap). On
> aarch64, string args get the same strdup+free treatment (companion-local
> `nomen_str_dup`); by-value struct arg staging remains a pre-existing
> limitation there. **Nursery borrows**: a non-Sendable CLASS argument may
> be passed inside `async { }` — a BORROW capture, sound because the join
> at block exit bounds it by the donors' lifetimes; the donor must be a
> named local or parameter (a temp dies at the statement), and
> `.detach()` rejects borrows outright (a daemon outlives every scope and
> must own its arguments). Outside a nursery the Sendable rule is
> unchanged. `nursery_depth` on CheckStatus tracks the enclosing async
> block. En route (the same session, from the ASYNC backlog): the
> `Awaitable` trait (Task<T> : Sendable, Awaitable — the consumption side
> of ASYNC_PLAN_2; trait tables are now exported from aarch64 single-TU
> builds and spawn-built Task handles install `_vt`, and a class
> conformer behind a `ref` trait param passes the INSTANCE on both
> backends — a pre-existing dispatch gap); and the first cooperative
> kill-trampoline pieces (Channel's non-fiber wait polls cancellation in
> bounded slices; the nursery join waits for done UNCONDITIONALLY after
> cancel — the 1s grace released futures under still-running tasks and
> let block teardown free a Channel beneath them). Still open (3e, if
> ever): migrating the sugar's packing onto the capture machinery proper
> (move semantics for owning donors); the forced-unwind kill trampoline.
> Green: new `test/spawn_env_ownership.test.ts` (6),
> `test/awaitable.test.ts` (4), `test/kill_kick.test.ts` (1) + full suite.
>
> **Status: Phase 3c LANDED — user-defined spawnables: the construction
> accepts a function value.** `Thread(fn)` / `Fiber(fn)` now take a
> ZERO-ARGUMENT function value in place of the unevaluated call: a lambda
> literal (`Thread(() => work(base))` — its CAPTURES are the eager
> arguments, Sendable-validated; fully self-typed signature required, with
> the return inferable from an expression body) or a zero-arg FUNC-TYPED
> binding / named function. A func-typed LOCAL is MOVEd into the task
> (use-after-move error; the adapter owns and disposes the closure — which
> also satisfies `.detach()`'s owned-capture contract by construction); a
> named function / capture-free declaration lambda borrows its
> thunk-backed STATIC descriptor (reusable, nothing to own). The task
> closure is a per-site ADAPTER (both backends): env = { user closure,
> result slot, cancel flag, future }, code calls the value through the
> descriptor ABI and completes the future. String results are
> alias-checked against a literal's captured strings (transfer fresh,
> strdup an alias — balanced); opaque closures (moved locals) duplicate
> and leak the original (leak-never-dangle); class/trait/struct results
> skip the dispose (may alias the env). En route: `parse_declaration`'s
> anonymous-function arrow bodies now set `is_arrow_body` (matching
> parse_function) so a lambda without a target signature infers its return
> instead of erroring, and `build_return_node` emits void arrow-expression
> returns as a statement (previously `long _return_val = <void call>`).
> The nursery escape hatch accepts the form (`pool.start(Thread(() => …))`).
> Not yet (3d): borrow-capture KINDS for the call-sugar's packed args
> (today the sugar hand-packs Sendable args — an owning-struct arg's heap
> fields still dangle; the capture machinery's move/strdup semantics are
> the fix), and the `Awaitable` consumption-side trait per ASYNC_PLAN.
> Green: new `test/fn_value_spawn.test.ts` (10 tests, both backends) +
> full suite (3451 passed / 3 known skips).
>
> **Status: Phase 3b LANDED — Thread/Fiber are real library classes.**
> `Thread(fn(args))` / `Fiber(fn(args))` now construct MONOMORPHIZED
> library classes (`core/System/Thread.nm`, `Fiber.nm` — `class Thread<T>`
> / `class Fiber<T> : Sendable` with `uint64` handle fields for the task
> closure / result slot / cancel flag / future plus a `started` flag, the
> same handle-through-uint64 pattern Task.nm established). The construction
> packs the wrapped call's arguments EAGERLY (Sendable-validated at the
> ctor — moved from the consumers) into the task env, allocates the
> future machinery (refs = 1: the instance's own), builds the heap task
> closure (the Phase-3a ABI), and yields the instance — a real, STORABLE
> value: `var t = Thread(work(n))` … `t.start()` is now legal (the
> checker's start/detach/start_on guards no longer require the receiver
> to be the chained ctor; T rides the receiver's type args). The launch
> emitters (start / detach / start_on / nursery escape hatch, both
> backends) read the handles from the receiver's fields, submit the
> packed closure, register the nursery, transfer the handles OUT of the
> instance (fields zeroed, `started = 1`), free a chained TEMPORARY
> instance (a stored binding's instance is freed by its owner's scope
> exit), and yield Task<T>. MUST-START is the library `#destroy` pattern
> (ASYNC_PLAN_2): destroying an unstarted value reports and aborts
> (`__nomen_spawn_must_start_abort`); a never-consumed construction is no
> longer an inert link-time error — the FOLLOWUP item is closed.
> `.detach()` releases the construction's unused future (detaching the
> closure from it — the daemon runner owns it). The per-site
> trampoline/args/descriptor emission moved wholly into the ctor; the
> launch sites are field-driven. Also fixed: a mono-construction
> referenced from a declaration initializer hit the class-init fast path
> (`bl Thread_init` — the generic init is never built); the aarch64
> declaration fast paths now defer magic ctors to build_node's
> intercept. Not yet (3c): borrow-capture kinds for the sugar, the
> Awaitable construction side. Green: task/fiber/daemon/spec-concurrency
> suites + new `test/thread_struct.test.ts` (6 tests, both backends:
> chained, store-later-start Thread/Fiber/start_on, stored detach,
> must-start abort, stored-nursery start) + full suite.
>
> **Status: Phase 3a LANDED — the spawn runtime speaks the closure ABI.**
> The pool, the fiber scheduler, and the daemon launcher now take a
> `struct nomen_closure *` task whose code receives the closure itself
> (`void (*)(struct nomen_closure *)`; the args struct rides in `env`).
> Every per-site trampoline (spawn / detached / fiber spawn-on /
> nursery escape hatch, both backends) is a closure body — `static void
tramp(struct nomen_closure *)` with env = args struct, plus a per-site
> static descriptor template; the site copies it into a heap descriptor
> (`owned = 1`) that the FUTURE owns via `owner_args` and the last
> `__nomen_future_release` disposes through the uniform free-if-owned arm
> (`__nomen_closure_dispose`: run `destroy_env`, free env, free descriptor
> — the same teardown a func-typed local gets). Lifetime is unchanged from
> the bare-args design: the free stays at the last future release, ordered
> after every use, so a worker's free never races the submitting thread's
> post-submit allocations. `spawn_arg_c_types` and the eager-arg packing
> are untouched — no capture semantics changed (that is the sugar's 3b
> work, with borrow-captures inside nurseries). Also fixed en route: the
> daemon form double-freed its args struct on BOTH backends (the generated
> trampoline freed it AND `__nomen_detached_run` freed `d->args` — the
> same pointer); the closure runner now disposes the task exactly once,
> after the body returns. The runtime text carries a NOMEN_CLOSURE_STRUCT-
> guarded struct definition so the globalized split-build TU is
> self-contained; `runtime_declarations` derives the new signatures
> automatically (test/runtime_split.test.ts asserts them). Green: the full
> suite (3433 passed / 3 known SPEC-gap skips), split-build objects for
> both backends. Nothing user-visible changed — the language surface is
> exactly the pre-3a sugar; the delta is that the spawn seam is now the
> closure descriptor, which is the substrate Thread/Fiber-as-library-
> structs (3b) and user-defined spawnables submit through.

## Tests

- Phase gates: full suite per phase, both backends.
- New `test/lambda_closure.test.ts`: capture kinds, move-only, free balance
  (audit), call-in-loop, nested lambdas.
- `test/lambda_arg.test.ts` extended for the descriptor ABI (a call through
  a func value now carries the hidden env).

## Relationship to other docs

- **Supersedes ASYNC_PLAN_2's fat-value framing** — the descriptor design
  avoids the signature flag day; ASYNC_PLAN_2's Phase-3 sequencing points
  here for the substrate.
- **`modify_T`'s "closures-free lambdas" contract** — raw bodies invoke
  func-typed params through the descriptor helper; the return-shape
  argument (fresh heap / boundary literals / input-derived) is unchanged.
- **No-closures assumptions** to retire as each phase lands:
  `check_value_node` (rejection), `last_use.ts` / `warnings.ts` /
  `scan_moved_param_consumed.ts` / `scan_inline_candidates.ts` (scans that
  skip nested functions), `CheckStatus` capture note,
  `owning_buffer_specialize` contract comments.
