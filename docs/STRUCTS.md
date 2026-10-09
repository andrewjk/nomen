# STRUCTS — the struct/move refactor, after the fact

This document consolidates the three struct/class design plans
(`STRUCT_PLAN.md`, `STRUCT_PLAN_2.md`, `STRUCT_PLAN_3.md`), which are now
deleted: **the refactor they proposed has landed.** The plans' remaining
truth — what shipped, what is deliberately unfinished, and how the code
changed — lives here; live residuals are tracked in [`FOLLOWUP.md`](../FOLLOWUP.md).

**Post-plan rename (2026-10-10).** The refactor shipped with the modifier
`owning struct` / `owning enum` and the keyword `move`. Both were respelled
after landing: the transfer keyword is now **`mv`** everywhere (bindings,
params, assignments, and the type modifier — `mv struct` / `mv enum`), and
`owning` is retired. The reasoning: `move` was the one English verb in a
vocabulary of concept tokens (`const`/`var`/`ref`/`view`), and its verb-ness
read badly in the modifier position ("move struct" parses as an imperative);
`mv` is grammatically inert like `ref`, completes the trio `var` (own,
mutable) / `ref` (alias) / `mv` (transfer), and frees `move` as an ordinary
identifier (which the `Buffer.move` extraction method immediately uses).
English prose still says "move/move-only" for the semantics; the keyword is
`mv`. Older documents and git history say `owning`/`move` — same concepts.

## The design, in one paragraph

`class` bundled a semantic axis (value vs reference at bindings) with a
representation axis (heap), producing silent aliasing, an unchecked
per-type decision, and a backend `->`/`.` duality. The final design (v3)
dissolved it: every type is a struct; **`struct` means Copyable and the
checker verifies it**; `mv struct` is the declared move-only escape
hatch; `Box<T>` is the spelled mv pointer (cycles, stable addresses);
`string` is mv; sharing is structure, not refcounts — nurseries give
concurrent lifetimes a lexical region, `ref` bindings spell in-scope
aliasing, and `WeakHandle<T>` covers the OS-retained residue. The
property the whole design serves:

> **Nothing aliases, copies, moves, or is edited without a marker at the
> point where it happens — and representation is never something the user
> has to guess.**

Decisions locked by v3 (all now embodied in code):

- **D1** — `owning struct` (today `mv struct`), not `owned struct`
  (a declared fact about the type: it owns heap resources).
- **D2** — `Box<T>`, not an `indirect` keyword (a library mv struct;
  `Box<T>?` is the natural null pointer).
- **D3** — `string` is mv; `view string` is the cheap read-only form.
- **D4** — no `shared struct` tier, no refcounts (v2's Phase C rejected).
- **D5** — `.detach()` owns its captures (move/copy only).
- **D6** — `WeakHandle<T>` is a core library type, not a keyword
  (global id + generation registry, opt-in, no refcounts).

## What was done

Executed as the "struct and move refactor", in the plan's dependency
order **A → N → B → B1/D3 → R** (Phase A landed 2026-10-04; ~7 weeks of
tranches; 38 feat commits plus ~30 fix commits; 589 files changed,
+15,352/−4,639 from Phase A's base to HEAD).

### Phase A — spelled aliases (commit `a740db24`)

- `ref` bindings parse and check: `ref Box q = p` is the spelled object
  alias; the unspelled `var Box q = p` is now an error ("use 'ref' to
  share it, 'mv' to transfer it, or '.copy()' for a deep copy").
- A1 syntactic trigger (bare identifiers and field chains); `ref` binds
  only heap-resident instances — slices use `view`.
- Lenient class-alias semantics preserved (owner defers its free);
  strict view-style invalidation deferred to after Phase N machinery.
- 57 files, +894/−119.

### Phase N — structure for concurrency (tranches 1–4)

- Nurseries aligned with the shipped async model (`docs/ASYNC.md`);
  `#spawn` keyed on the member; `Spawnable<T>` with `Thread`/`Fiber`
  conformance; `Sendable` shrunk to shared references.
- **R1/R2 checked region borrows**: spawn arguments are env-owned by
  default (mv bare = const borrow into the env — the silent deep
  copy per spawn is gone); a borrowed capture's root must be declared
  in a scope enclosing the `async` block (`spawn_region.ts`).
- **R3 the freeze**: borrowed roots are read-only from construction
  until the `async` block exits; `Atomic<T>` methods are the sanctioned
  mutation path.
- **R4/E3 tightened now**: `.detach()` owns its captures (move/copy
  only — the live daemon dangle fixed); `Sendable` spawn arguments must
  also be join-bounded.
- **N3 `WeakHandle<T>`**: core type (`core/System/WeakHandle.nm`), one
  process-wide `(pointer, generation)` registry with a free-list,
  content-keyed runtime emission, `#destroy` generation bump,
  bind-once rule, `.get() -> T?`.
- **N4 protected slots**: `Atomic<T>` joined core
  (`core/System/Atomic.nm`) with both-backend magic; the shareability
  derivation (every `var` field must be a protected slot) and the
  mutation error naming the unprotected field are checker-enforced.
- 97 files across four tranches.

### Phase B — unify value types (tranches 1–4)

- **B2 `Box<T>`**: core mv struct (`core/System/Box.nm`); boxing is
  forced and prescribed by the cycle check ("field 'next' closes an
  inline containment cycle — declare it `Box<Node>`"); move-only with
  transfer rules; `Box<T>?` lowers to a null pointer.
- **B4 trait objects**: trait-typed positions carry boxed
  `(vtable, instance)` handles in **both** backends; boxing takes
  ownership (the annotation is the marker); the tier-1/tier-2 checker
  distinction (`value_struct_trait_error`) was deleted; stack-copy
  boxes at bare trait params (T3 calling convention).
- **B5 field collapse**: "struct fields cannot be class/trait types" is
  replaced by "a mv-typed field forces `mv struct`"; `var` +
  mv type = transfer-on-store with swap extraction; no `mv T`
  field spelling.
- **B6 nullable lowerings**: `Box<T>?`/pointer-shaped = null slot;
  inline struct `T?` = companion flag (`nullable_struct.ts`).
- ~130 files across four tranches.

### Phase B1 + D3 — declared ownership and the string rule (cutovers)

- **B1/B1a**: `mv struct` / `mv enum` parse, bind, and are
  verified — the Copyable verifier fails at the definition
  ("'Config' cannot be Copyable — field 'history' owns heap memory -->
  mark the struct `mv struct Config`"); `is_owning_struct_type`
  reads the declared flag (the field walk became the verifier);
  built-ins migrated (`List`, `Map`, `Buffer`, `Channel`, `Mutex`,
  `Thread`, `Fiber`, `Task`, `Box`, `WeakHandle`, `Atomic`, `string`).
- **D3**: `string` is a declared mv type; mv-struct string
  fields are uniform-heap on both backends (the value-struct raw store
  is gone); string moves/copy rules follow the mv machinery.
- 266 files across the two cutovers and D3.

### Phase R — retiring `class` (tranches 1–4e + cleanup)

- `class` parses to a dedicated error: _"'class' has retired — declare
  `mv struct` (single-owner, move-only) and spell sharing where it
  happens (`ref`, `Box<T>`, `Mutex<T>`, `WeakHandle<T>`)"_
  (`src/parse/utils/class_retired_error.ts`). Zero `class` declarations
  remain in `core/`.
- `core/` rewritten per the shape menu: `Mutex`/`Channel`/`Thread`/
  `Fiber`/`Task` are mv structs with handle fields; `#spawn` works
  on mv structs; `Task<T>` is an inline mv-struct value; trait
  handles box everywhere; env packing for borrowed mv arguments
  reuses the class-arg path minus the destroy.
- SPEC.md and README.md rewritten to the new model (the "struct or
  class?" question is gone from the language contract).
- 304 files across nine tranches.

## How the code has changed

User-visible language changes (before → after):

| Before                                            | Now                                                           |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `class Window { ... }`                            | `mv struct Window` (class = parse error)                      |
| `class Node { var Node? next }`                   | `mv struct Node { var Box<Node>? next }`                      |
| `var Box q = p` (silent alias)                    | error — `ref Box q = p` / `mv` / `.copy()`                    |
| `struct Config { var List<Log> h }` (silently ok) | error → `mv struct Config` (verified)                         |
| string field raw-store in value structs           | `string` mv; heap-uniform on both backends                    |
| value-struct conformers only in trait locals      | boxed `(vtable, instance)` handles at every trait site        |
| silent deep copy of mv spawn arguments            | bare mv = checked region borrow (join-bounded)                |
| daemon `.detach()` sharing class args (dangling)  | detach owns its captures: move/copy only                      |
| unmarked shared mutation across tasks             | freeze + protected slots (`Atomic<T>`); errors name the field |
| OS-retained delegates via class aliasing          | `WeakHandle<T>(obj)` + checked `.get()`                       |
| `T?` on classes = null pointer, structs = flag    | pointer-shaped = null slot; inline struct = companion flag    |

Code-level changes:

- **Checker**: declared-ownership flags on `StructNode`/`EnumNode`; the
  Copyable verifier; `ref` binding checks; `spawn_region.ts` (R2 region
  rule, R3 freeze/write gate); detach/`Sendable` boundary validation;
  `check/utils/box.ts`; the tier system deleted.
- **Backends (C and aarch64)**: `Box` magic (constructor, destroy =
  destroy-pointee + free, transparent access); trait-handle boxing at
  every trait position with vtable destroy dispatch and stack-copy
  boxes at bare params; `WeakHandle` registry emission (content-keyed);
  `Atomic<T>` (acquire-release load/store on aarch64); env packing for
  region-borrowed spawn arguments; uniform-heap string fields.
- **Runtime**: the id+generation weak registry; mv-struct task
  handles; `#spawn` on mv structs.

## What remains

The design is fully landed; what follows is the deliberately-deferred
and residual list (full detail in `FOLLOWUP.md`, which is the tracker).

### Docs debt (teach retired syntax — rewrite before citing)

- `docs/BORROW.md` still teaches `mov` and the pre-B5 field rules.
- `docs/ASYNC.md` still teaches `Sendable`-gated class spawning and the
  opaque-closure spawn leak as current.

### Deferred by design (recorded, not bugs)

- **N4 remainder**: `Shared<T>`, the `with(m) (T g) { … }` critical-
  section form, and a typed generic `Mutex<T>` — designed, not built
  (checker-level desugar with a scope-guard `#destroy`). Until then:
  hand-locked `Mutex` + `Atomic<T>`.
- **E2 endgame**: string lambda captures are read-invalidated but
  memory-snapshotted (sound; matches pre-D3 output).
- **E4**: opaque-closure spawn string result leaks the original
  (leak-never-dangle, bounded at one per run; posture decided in
  `docs/ASYNC.md`).
- **B5 remainder**: trait-typed fields on mv structs stay rejected
  ("concrete type, or `Box<Concrete>`") until a boxed-handle field
  lowering exists — may stay rejected permanently.
- **B4 corners**: root-scope trait consts re-derive their box per use;
  `return <computed concrete>` from a trait-returning function inside a
  switch/match/if join falls through the generic join path.

### B1/D3 residuals (checker)

- Generic struct mono with a bare-`T` field derives `is_owning`, but
  the generic template itself isn't flagged — `mv struct Wrapper<T>`
  must be spelled.
- Variadic-pair extraction of mv elements (`Map` pairs init) rides
  a temp-rooted read exemption until a generic move-out accessor exists
  on `Array`.

### Test-corpus skips naming live gaps

- Compile-time division/modulo-by-zero (`operations`, `interpolate_string`)
  — a language-feature ask, not a backend bug.

### Pointers

- Live tracker: [`FOLLOWUP.md`](../FOLLOWUP.md) (all sections above
  have fuller entries there, plus unrelated remainders: ownership
  tracking through calls, container element fields, `Buffer` holes,
  kill-trampoline teardown, `Fiber.start_on`, aarch64 code quality).
- Language contract: `SPEC.md` (structs, `Box<T>`, `WeakHandle`, async
  argument rules, `Mutex`/`Channel` shape-menu entries).
- Memory model: `docs/MEMORY.md`.
