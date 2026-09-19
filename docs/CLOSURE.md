# Closures & Capturing Lambdas

Documents the closure model as shipped. For the user-facing contract, see
SPEC.md's "Anonymous Functions (Lambdas)" section; for the memory-ownership
rules captures build on, see MEMORY.md.

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
  — used for func-typed locals at scope exit, func-typed class fields'
  `#destroy`, and the runtime's task teardown.
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
  only in the spawn sugar (see "Spawn constructions" below), where the
  nursery's join bounds them.

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
rejected. Containers and return positions of func values are not
expressible in the language (generic type args and `out` types don't parse
`func (...)`), so the shared-ownership container case is unreachable.

## Anonymous functions

Three forms — an arrow expression, an arrow with a block, and a block
without the arrow. Parameter and return types are inferred from the target
signature when the lambda arrives at a func-typed destination (a param, a
func-typed field's constructor argument, a declaration's annotated type);
standalone lambdas must be self-typed, with an expression body's return
type inferred when no `out T` is declared.

## Spawn constructions over closures

`Thread`/`Fiber` are real library classes (`core/System/Thread.nm`,
`Fiber.nm`): the construction packs a task closure and yields a storable
value; the runtime's pool, fiber scheduler, and daemon launcher all take a
`struct nomen_closure *` task whose code receives the closure itself.

### The call form: `Thread(fn(args))`

- Arguments are evaluated EAGERLY (at the construction, Sendable-validated)
  and packed into the task env — the env is an OWNING struct: fat `string`
  args are deep-copied at pack (the env destructor frees its copy), and on
  the C backend an owning value-struct arg is a malloc'd copy whose
  top-level string fields are strdup'd, then `<T>_destroy`ed and freed. A
  raw byte copy would alias the donor's heap fields and dangle at the
  donor's scope exit.
- **Nursery borrows**: inside `async { }`, a non-Sendable CLASS argument may
  be passed — a borrow capture, sound because the join at block exit bounds
  it by the donors' lifetimes. The donor must be a named local or parameter
  (a temporary dies at the statement). `.detach()` rejects borrows: a
  daemon outlives every scope and must own its arguments. Outside a nursery
  the Sendable rule is unchanged.
- The construction is a real, STORABLE value: `var t = Thread(work(n))` …
  `t.start()` is legal; `T` rides the receiver's type args. Launch
  (`.start()` / `.start_on(buf)` / `.detach()` / a nursery's `.start(...)`)
  reads the packed handles from the receiver's fields, submits, transfers
  them out (fields zeroed, `started = 1`), and frees a chained TEMPORARY
  instance; a stored binding's instance is freed by its owner.
- **Must-start**: destroying an unstarted `Thread`/`Fiber` reports and
  aborts (`#destroy` checks the started flag) — a never-consumed
  construction is a runtime error, not a silent no-op.

### The function-value form: `Thread(() => fn(args))`

A zero-argument function value in place of the unevaluated call — the
lambda's CAPTURES are the eager arguments (Sendable-validated; owning
captures move). Accepted: a lambda literal (fully self-typed params; an
expression body's return is inferred), a zero-arg func-typed binding, or a
named function.

- A func-typed LOCAL is MOVEd into the task: the task's adapter owns and
  disposes the closure (which is what makes `.detach()`'s owned-capture
  contract hold by construction); using the local afterwards is a
  use-after-move error.
- A named function / capture-free declaration lambda borrows its
  thunk-backed STATIC descriptor — reusable, nothing to own.
- The task closure is a per-site ADAPTER: env = { user closure, result
  slot, cancel flag, future }; the code calls the value through the
  descriptor ABI and completes the future. String results are alias-checked
  against a literal's captured strings (transfer fresh, strdup an alias —
  balanced); a moved local's opaque closure duplicates and leaks the
  original (leak-never-dangle); class/trait/struct results skip the dispose
  (they may alias the env).

### `Awaitable`

`core/System/Awaitable.nm` — the consumption side: park-flavored
`func wait = (ref self)`. `Task<T>` conforms (`: Sendable, Awaitable`), and
every spawn yields one, so a generic helper over `Awaitable` waits on any
task — thread, fiber, or nursery-spawned. Must-start is deliberately NOT a
trait rule: start-optional lifecycles are legitimate for user primitives;
it is a per-struct `#destroy` contract.

### The generalized flavor: user Awaitable classes

The construction is not reserved for the two library names. Any user CLASS
conforming to `Awaitable` that declares the spawn-field contract (uint64
fields `task` / `result_slot` / `cancel_flag` / `future`; optional `started`
bool) gets the same sugar — `MyThing(fn(args))` / `MyThing(() => work(n))`
pack eagerly and yield a heap instance with the handles in the contract
fields. Launch is the class's own business: pure-Nomen methods over the
`Task.pool_submit` / `Task.future_*` seam (the same runtime calls the
generated Thread/Fiber launch code makes — raw blocks stay library-only).
A contract-missing class gets a dedicated compile error rather than a
failed `#init` lookup; the construction zero-builds the instance (no
`#init`, no field initializers); Sendable is enforced identically; and the
construction materializes `Task<T>` so the seam's statics link. See
ASYNC.md, "User-defined async primitives", and test/awaitable_ctor.test.ts.

## Raw bodies and the descriptor ABI

Raw `#arch: c` bodies that invoke func-typed parameters (`modify_T` and
friends) route through the descriptor: call `((Ret (*)(void *, Ps))f->code)(f->env, args…)`. The `modify_T` return-shape contract is unchanged: the
function's returned owning fields must be fresh, null, or identical to the
input's — sound because lambdas' returns can only be fresh heap, boundary
literals, or input-derived.

## Current restrictions

- Capturing lambdas stored in containers: unreachable (func values don't
  parse in generic type args or `out` positions).
- Borrow-captures in general lambda positions: rejected; only the spawn
  sugar's nursery borrows exist.
- The spawn sugar's arg packing is not yet the capture machinery proper
  (owning donors are copied, not moved — donor visibility unchanged). If
  ever desired, that migration is the recorded "3e".
- aarch64 spawn-arg staging passes one word per non-string arg: by-value
  struct args are a pre-existing limitation there.
