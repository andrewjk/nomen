# Closures & Capturing Lambdas

Documents the closure model as shipped. For the user-facing contract, see
SPEC.md's "Anonymous Functions (Lambdas)" section; for the memory-ownership
rules captures build on, see MEMORY.md. The async machinery that motivated
this work lives in [ASYNC.md](ASYNC.md) — closures are an independent
language feature, and the spawn constructions are just one consumer of them.

## Anonymous functions

Two shapes — the arrow expression `(params) => expr` and the keyword block
`func (params) { ... }`:

```
(a, b, out int) => a + b            // arrow expression (implicit return)
func (x, out int) { return x * 2 }  // keyword block (explicit return)
```

Parameter and return types are inferred from the target signature when the
lambda arrives at a func-typed destination (a param, a func-typed field's
constructor argument, a declaration's annotated type). Where no target
signature exists, the lambda must be self-typed: parameter types are
declared, an expression body's return type is inferred, and a block body
declares its return as the leading `out T` (`func (out int) { ... }`). Both
shapes parse as inline call arguments. The bare `( ... )` group is
recognized as a lambda only when `=>` follows the matching parenthesis —
`=>` takes a single expression, and block bodies require the `func`
keyword, since a parenthesized group followed by a block is elsewhere
exactly a statement condition (`if (cond) { ... }`).
In every shape the lambda is an ordinary anonymous function: `is_closure` is
stamped at parse and the descriptor ABI below applies unchanged — closures
added no syntax of their own.

## The descriptor ABI

A func-typed VALUE is a pointer to a closure descriptor; signatures never
change — func-typed params, fields, locals, and returns stay one word (one
register on aarch64; no arg-slot shifts, no pair ABI, no sret):

```c
struct nomen_closure {
	void *code;   // the lowered lambda / function
	void *env;    // capture environment; NULL for capture-free
	int owned;    // 1 = heap descriptor owning env; 0 = static, never free
	void (*destroy_env)(void *);  // frees the env's owned captures
};
```

- **Indirect calls gain the env**: `ret = code(env, args…)`. Lambda
  definitions lower as `Ret _lambda_N(Env *env, Args…)`. A named function
  used as a value gets an auto-generated thunk with the same hidden first
  parameter that shifts the argument slots and tail-calls the unchanged
  original — every func value wears one ABI.
- **`owned` + `destroy_env`**: capture-free functions get STATIC descriptors
  (emitted once per function, never freed); capturing lambdas get heap
  descriptors that own their env. The destroy path is the uniform
  free-if-owned arm: `if (owned) { destroy_env(env); free(env); free(v); }`
  — used for func-typed locals at scope exit and func-typed class fields'
  `#destroy`.
- **Codegen cost**: two loads per indirect call. Nothing else.
- aarch64 has no C struct: descriptors are 32-byte tables (`code`, `env`,
  `owned`, `destroy_env`) in `__DATA` — text→text relocations are illegal on
  arm64 Mach-O — reached via `adrp`+`add`.

## Capture kinds

A lambda body referencing an outer local captures it; the capture is taken
once, when the lambda value is created. The env is a compiler-generated
OWNING struct — one field per capture — so every rule that ships for owning
structs applies unchanged:

- **Scalars**: copied (snapshot semantics — a later write to the source is
  not seen).
- **Strings**: deep-copied (`nomen_str_dup`); the local keeps its own.
- **Non-owning value structs**: copied (C holds a pointer to a malloc'd
  copy — the struct's full definition lands after the env typedef —
  aarch64 stores the bytes inline).
- **Owning value structs, class instances, class-backed trait references,
  and other func-valued closures: MOVED** — the donating local is
  invalidated (using it again is a use-after-move error) and the env owns
  and destroys (env destructors run `<T>_destroy` / the class destroy).
- **Not capturable**: `ref`/`var` borrows, views, arrays, raw pointers,
  value-struct trait slots (inline conformer storage), a borrowed (non-
  `move`) class/trait/owning-struct parameter, and a func-typed PARAMETER
  (a borrow — the caller still owns the descriptor). Borrow-captures exist
  only in the spawn sugar's nursery form (ASYNC.md, "Nursery borrows"),
  where the join at block exit bounds them.

Capture stamps live on the lambda's `FunctionNode.captures`; the checker
funnels every reference form through `type_from_value` (reads, method
receivers, assignment targets), so all of them capture.

## Move-only capturing values

Copying a capturing closure would share the env — double free. The rule is
per-expression, not per-type: initializing, assigning, or passing a
CAPTURING lambda moves it (the source is invalidated); capture-free lambdas
and named functions are freely copyable (static descriptor, nothing to
free). Func-typed TYPES remain copyable in signatures; only capturing
VALUES are move-only.

A CLASS func-typed field can own a closure (`<Class>_destroy` reclaims it
via the free-if-owned arm); a VALUE-struct func-typed field cannot (copies
would share the descriptor), so storing a capturing closure in one is
rejected. Containers holding func values are not expressible (generic type
args don't parse `func (...)`), so the shared-ownership container case is
unreachable.

A `func`-typed RETURN (`out func (out int)`) is expressible — a closure
factory (SPEC, "Function-Typed Parameters"). The returned descriptor is
owned by the CALLER: the call site's func-typed binding registers for the
scope-exit free-if-owned arm and is move-only (a factory-produced closure
may own captures), and a bare `return f` of a func-typed local transfers
its descriptor (use-after-move afterwards). Signatures nest — a `func`
type may appear as a parameter type or in a return slot at any depth
(`func (func (out int), out int)`) — and each signature has two spellings:
the keyword form `func (T1, T2, out R)` and the arrow form
`(T1, T2) => R`. Both parse to the same Type, so the disposal gates for
inline capturing lambda arguments — which key off the callee parameter's
signature — apply unchanged at higher-order call sites.

## The spawn seam

The async runtime speaks this ABI: a submitted task IS a
`struct nomen_closure *` whose code receives the closure itself — the pool,
the fiber scheduler, and the daemon launcher all take one. The spawn
constructions (`Thread(fn(args))` / `Fiber(fn(args))`, the function-value
form, and the generalized user-Awaitable flavor) pack the wrapped call's
arguments eagerly into an owning env, or wrap a given function value
through a per-site adapter. Those mechanics — eager packing and its
ownership rules, Sendable validation, nursery borrows, must-start, the
`Task.pool_submit` / `Task.future_*` launch seam — are documented in
ASYNC.md ("Spawn arguments are owned by the task env", "Function-value
constructions", "User-defined async primitives"), not here.

## Raw bodies and the descriptor ABI

Raw `#arch: c` bodies that invoke func-typed parameters (`modify_T` and
friends) route through the descriptor: call
`((Ret (*)(void *, Ps))f->code)(f->env, args…)`. The `modify_T`
return-shape contract is unchanged: the function's returned owning fields
must be fresh, null, or identical to the input's — sound because lambdas'
returns can only be fresh heap, boundary literals, or input-derived.

## Current restrictions

- Capturing lambdas stored in containers: unreachable (func values don't
  parse in generic type args).
- Borrow-captures in general lambda positions: rejected; only the spawn
  sugar's nursery borrows exist (ASYNC.md, "Nursery borrows").
- An INLINE capturing lambda passed directly as a call argument — plain,
  method, or trait-dispatched — is a one-shot: the parameter is a borrow,
  so the call site disposes the temporary heap descriptor + env once the
  call returns (both backends). Capture-free inline lambdas were always
  fine (static descriptors).
- A func FIELD call (`s.f(...)`) cannot carry lambda arguments today: a
  field's func signature cannot declare a nested `func (...)` param in the
  field-declaration grammar (`var func (func (out int), out int) f` does
  parse as a LOCAL type annotation, but the struct-field form rejects the
  nested spelling).
