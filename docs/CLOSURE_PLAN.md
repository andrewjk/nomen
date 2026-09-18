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
>   accessor), aliased (`var Box b = a`), or `move`-parameter class reference is
>   rejected — it is not the closure's to own.
> - **Nested closures**: a func-valued local/param is captured by MOVE. A
>   func-valued StackValue from an `out`-returning signature carries the RETURN
>   type, so capture analysis detects func values structurally
>   (`func_params`/`func_return_type`) and records a normalized `func` type.
>   Calls to a captured func value route through the closure env on both
>   backends (C's `is_func_param` path and aarch64's descriptor reload consult
>   the capture map); the env's `destroy_env` uses the same owned-flag
>   free-if-owned arm as a func-typed local. The nested-capture reference is
>   recorded at the func-VALUE call resolver (not `type_from_value`), which had
>   bypassed the funnel.
>
> Also fixed en route: `build_function_node` (aarch64) now isolates
> `heap_cleanup_stack` per function. Without it a lambda's return-path cleanup
> iterated the ENCLOSING function's heap anchor slots and freed them from
> inside the lambda (double-free of a class local captured — or merely live —
> around the lambda).
>
> **Still deferred (follow-ups, sound today)**: capturing a TRAIT (dispatched
> destruction through the vtable shim), capturing a `move`-class / func
> PARAMETER (the callee's own cleanup still runs), and STORING a capturing
> closure in a func-typed field/container or returning it (the env+descriptor
> leak — `owned`-flag/static descriptors keep it sound, never dangling; the
> container case is a shared-ownership-family rejection). Move-on-assignment
> for capturing values (the design's "assigning, passing, or returning a
> capturing lambda moves it") is the prerequisite for the field/return arms
> and remains unimplemented.

**Phase 3 — the ASYNC_PLAN_2 payoff (separate landing).** `Thread`/`Fiber`
de-specialized into library structs over capturing lambdas; the
`Thread(fn(args))` sugar keeps eager-arg borrow-captures inside nurseries
(scope-depth-expressible: the sugar only exists in `async { }`); `.detach()`
enforces owned captures; must-start via the library `#destroy` pattern; the
`Awaitable` construction side opens user-defined spawnables.

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
