# STRUCT_PLAN_2 — a revised struct/class plan

A revision of [`STRUCT_PLAN.md`](./STRUCT_PLAN.md) after checking its premises
against the current compiler. The thesis of v1 is right — `class` bundles a
semantic axis (value vs. reference at bindings) with a representation axis
(heap), and Nomen already has most of the vocabulary to separate them — but two
of its load-bearing facts are wrong, and it proposes the hardest work
(trait-object and concurrency representation) as an afterthought. This version
corrects the premises and splits the work into three phases so the one real,
independently-valuable fix ships without waiting on the risky parts.

The property the whole design serves is unchanged:

> **Nothing aliases, copies, moves, or is edited without a marker at the point
> where it happens — and representation is never something the user has to
> guess.**

## TL;DR

| Phase | Scope                                                                                 | Risk   | Gate                               |
| ----- | ------------------------------------------------------------------------------------- | ------ | ---------------------------------- |
| **A** | Spell class aliases (`ref` bindings). No representation change.                       | Low    | none — do now                      |
| **B** | Unify value types: `struct` / `owned` / `indirect`, string rule, trait-object boxing. | Medium | Phase A landed                     |
| **C** | Reference/identity tier for concurrency + FFI; only then retire or rename `class`.    | High   | a concurrency/FFI ownership design |

Phase A closes the only hole that is real today. Phase B makes new code almost
never need `class`. Phase C is the actual hard problem and must not be
hand-waved.

---

## Corrections to v1 (verified against the compiler)

v1 cites current source, so these are checkable. I compiled the shapes it names
and the results are the opposite of what it assumes.

### C1. The "Go/Swift bite" does not exist

v1 §Where-we-are item 1, the §4 headline ("the crucial change"), and the
"big behavioral change" row of its migration table all rest on the claim that
`func f = (Box b) { b.set(1) }` compiles and mutates the caller's instance
while `func f = (Point p) { p.x = 1 }` does not.

It does not compile. Bare parameters are `const` for **every** type:

```
class Box { var int v; func set = (ref self, int x) { self.v = x } }
func f = (Box b) { b.v = 1 }        // error: Assignment to const: b
func f = (Box b) { b.set(1) }       // error: Update to const: b
func f = (var Box b) { b.v = 1 }    // error: 'var' parameters are not allowed …
```

`check_function_parameter_node.ts:81` rejects `var` parameters outright;
`check_access_node.ts:732` rejects mutating calls on `const` locals. So
mutation visibility is **already** decidable from the signature and call-site
text. v1's §4 is not a change — it is a description of today's behavior. The
migration cost of that item is zero, and it cannot be the reason to retire
`class`.

The leak is real, but it lives in v1's item 2, not item 1: a silent alias makes
the object mutable through the alias, and _then_ the alias is mutated.

```
func f = (Box b) { var Box q = b; q.v = 1 }   // compiles: q aliases b, q is var
```

This is why Phase A targets aliasing, not parameters.

### C2. The string premise is inverted

v1's table row `struct P { var string s }; var q = p → raw alias today` and the
"aliasing bug waiting to happen" framing in §The string question are wrong.
`is_owning_struct_type` already counts `string` as owning
(`src/check/utils/ownership.ts:159-161`), so a copy is a hard error today:

```
struct P { var string name }
var P a = P("hi")
var P b = a        // error: cannot copy 'P' by value — it owns heap resources
```

The raw store v1 refers to is only the _field-default_ path
(`build_c/build_struct_node.ts:213-230`), not binding copies. There is no
existing double-free bug to fix here, so the motivation for v1's option **(2)**
(string fields silently dup on copy) evaporates — and option (2) would
introduce exactly the hidden, unmarked O(n) copy the opening principle
forbids. See "The string decision" below: option (1) is the principled answer.

### C3. "Placement is never the user's problem" is too strong

Identity is a second, _observable_ reason to box, independent of the
self-reference cycle v1 addresses with `indirect`. Types handed to FFI (AppKit
retains the `NSWindow`; a delegate pointer outlives the call), captured by a
`self` in a worker, or shared across tasks need a stable address that survives
moves. v1 asserts "class Window / Channel / Mutex → `owned struct`, placement
unchanged in practice", but that only holds when the real resource hides behind
an integer handle field (as `Mutex` and `Window` do) — it is not a general
guarantee. `indirect` must be justified by **both** cycles and identity, and
the plan must say so.

---

## What v1 gets right (keep)

- `class` conflates axes; separating them is worth doing.
- Rejecting fully-inferred semantics (adding a field silently changing
  `var b = a` at every use site) is correct and well argued.
- Rejecting opt-in `Copyable` + a warning-on-every-struct nag is correct.
- `indirect` for self-reference, spelled at the field, is the right call.
- The `ref` binding vocabulary (§5) is the right shape.
- Value structs may contain any struct once `owned` marks the heap dependency;
  the field-restriction zoo in `check_struct_node.ts:140-159` should collapse.
- The `is_owning_struct_type` machinery is the moral equivalent of v1's `owned`
  axis, which makes `owned` a defensible keyword (it already means "owns heap →
  move-only"). It is _not_ free-floating.

---

## Phase A — spelled aliases (do now)

**Goal.** Close the one verified hole: `var Box q = p` aliases silently.
Nothing about layout, traits, concurrency, or the `struct`/`class` split
changes.

### The binding vocabulary, by position

Phase A is not a wholesale rework of binding semantics. Parameters already carry
the full read-only / alias / transfer vocabulary; locals are missing only the
general **alias** form, so class aliasing leaks through `var`. Phase A extends
the param vocabulary (`ref`, `move`) to locals.

| Position          | read-only / owned            | alias / borrow             | transfer                |
| ----------------- | ---------------------------- | -------------------------- | ----------------------- |
| params            | bare `T x`                   | `ref T x` (mutable borrow) | `move T x`              |
| locals (before A) | `const x`                    | `view x` (slice only)      | `move x`                |
| locals (after A)  | `const x`                    | `ref x` / `view x` (slice) | `move x`                |
| fields            | `const` / `var` / `readonly` | `view T` (slice only)      | `move T` (owning field) |

Notes on each position:

- **Params are already complete.** Bare is read-only (copy for Copyable types,
  const-borrow for owned/reference types), `ref` is a mutable borrow that must
  be spelled at both definition and call site, and `move` transfers. No change.
- **Locals gain `ref`.** This is the only new form. `view` already exists, but
  it is a `(ptr, len)` **slice** borrow — immutable, borrow-tracked, for
  buffers/strings — not a general object alias. `ref x` is the general 8-byte
  alias that `var Box q = p` currently performs silently. `for ref x of arr`
  is the existing mutable loop-binding variant of the same idea.
- **Fields can transfer, but not borrow.** A field may be declared `move T x`
  — an owning field whose stores must transfer (a fresh value, a `move`
  local/param, or an owned local; extraction back out needs `move ... swap`) —
  alongside `const` / `var` / `readonly` and `view T`. What fields cannot do is
  **alias**: `ref T` fields are rejected today
  (`check_struct_node.ts:137-144`: `"struct fields cannot be 'ref'"`), and
  Phase A keeps that rejection. A parameter or local borrow lives inside a
  lexical scope the borrow checker can reason about; a field lives inside a
  value that can be moved, returned, or outlive its source, so an unchecked
  8-byte pointer field is exactly the use-after-free the cve-rs probes close.
  `view T` fields are allowed precisely because a view is a self-contained
  `(ptr, len)` pair with no dangling pointer. A struct that must point at
  another object uses an `indirect`/owned box (`move`) or a reference
  (`class`) field. Field-level `ref` would require lifetime parameters on
  structs, which Nomen does not have; revisit only if it gains them.

So the vocabulary is intentionally **not** uniform across positions: borrows are
permitted wherever there is a lexical scope to check them, and a struct field is
not such a scope.

**Rule.** A declaration whose initializer _reads an existing binding or a
field_ and whose type is a reference type must say what it is doing:

```nomen
ref Box q = p          // alias, spelled; owner defers its free
move Box q = p         // transfer; p is invalid afterwards
var Box q = p.copy()   // deep copy (owning types)
var Box q = Box(0)     // fresh temporary: unchanged
var Box q = make()     // fresh owned return: unchanged
```

`var Box q = p` becomes `error: 'p' is aliased — use 'ref' to share it,
'move' to transfer it, or '.copy()' for a deep copy`. The same spelling applies
to borrows out of fields (`ref Box q = holder.field`), which today ride the
child-group borrow path.

**Semantics (deliberately status-quo).** A `ref` binding keeps the present
lenient class-alias behavior: the owner defers freeing its old instance on
reassignment, and mutation through the alias is visible and expected (it is
spelled now). Mutation through a `ref` binding requires the source to be a
`var`; a `ref` binding is itself not reassignable. Unifying on strict
view-style invalidation remains a **follow-up flagged as a behavior change**
(v1 §5), not part of Phase A.

**Why this is the right first step.** It is the verified leak, it is spelling
only, it needs no new representation, and it is the smallest thing that makes
the aliasing hazard impossible to miss. It also delivers most of v1's safety
story on its own.

**Implementation surface.** Parse the `ref` binding form (mirroring the
existing `view` binding normalization in `check_declaration_node.ts:62-89`);
in `check_declaration_node.ts:445`, replace the silent `class_alias_of`
fallback with an error unless the binding is `ref`/move; set `borrow_depth`/
`borrowed_from` (or the lenient `class_alias_of`, preserving today's build
handling) from `utils/borrow.ts`. Both backends already classify the alias
syntactically, so codegen is unchanged.

**Tests.** `test/mov_ownership.test.ts`, `test/swap.test.ts`, and the class
cases in `test/list.test.ts` that today write `var Box q = p` need the `ref`
spelling; add error tests for the unspelled form.

---

## Phase B — unify value types

Everything here applies to types with **no shared identity**. It is gated on
Phase A because aliases must be spelled before the semantic axis can move.

### B1. `struct` is the default; `owned` is the verified escape hatch

Adopt v1 §1–2 (bare `struct` means Copyable, checker-verified; `owned struct`
for move-only, inline storage). Keep the name `owned` — it aligns with
`is_owning_struct_type` — but document the user-visible meaning as **move-only
/ not Copyable**, and state plainly that converting a class to `owned` changes
it from a shared reference to a single-owner move (a real behavior change).

### B2. `indirect` covers cycles _and_ identity

Adopt v1 §3, with C3 folded in: boxing is required (and spelled) when a struct
would contain itself, **and** when a value needs a stable address that outlives
a move (handed to FFI with an untracked lifetime, captured by a worker, shared
across a boundary the borrow checker cannot span). One keyword, two documented
reasons; nothing boxes silently.

### B3. Parameter modes: describe, don't change

Because C1 shows the mechanism is already right, Phase B only _documents_ the
contract that bare `T x` is read-only, `ref T x` is a spelled mutable borrow,
and `move T x` transfers — uniformly for every type. No behavior change, no
migration row.

### B4. Trait objects (the part v1 omits)

Today dynamic dispatch needs a stable pointer: value-struct conformers are
allowed only in trait-typed **locals** (tier 1, `src/check/utils/trait_slot.ts`),
and every call/container boundary requires a `class` (tier 2, the
`value_struct_trait_error`). Removing classes removes the stable slot that
`ClassBuffer<Control>` and trait params rely on.

Phase B must specify the conversion explicitly:

- A trait-typed binding/param/field is a **boxed handle**: `(vtable, instance)`.
- Assigning a concrete struct to a trait-typed slot **boxes** it — the trait
  type in the annotation is the marker. Boxing a local is a move (the source is
  invalidated); boxing a fresh temporary is free.
- The tier-1 inline-local optimization may survive as an optimization, but it
  must no longer be load-bearing for correctness.

Until this is specified in both backends, do **not** remove `class` for any
type used as a trait object. This is the single largest hidden cost in v1.

### B5. Collapse the field restrictions

With `owned` present, "struct fields cannot be class/trait types"
(`check_struct_node.ts:157-171`) becomes "an owning field forces `owned`". Do
this last, after B4 fixes the trait representation.

---

## Phase C — reference identity (gate for deleting `class`)

Concurrency and FFI keep a reference tier; `class` must not be deleted before
this exists.

The `Mutex`/`Channel`/`Task`/`Fiber`/`Thread` cluster and the AppKit controls
share one property: their identity is referenced across a boundary that
**outlives any lexical borrow** — another worker thread, an async task, or the
OS. A `ref` binding is a lexically scoped borrow; it cannot express "two
workers hold the same lock". Today's silent class aliasing is doing real work
for these types, so erasing it without a replacement would break concurrency,
not just tighten it.

Recommended shape (a design task in its own right):

- Keep a single explicit reference form (rename `class` → `shared` for
  semantics, or retain `class` and document it as the identity tier), required
  only where sharing crosses a boundary the borrow checker cannot span:
  trait objects stored across calls, concurrency handles, FFI-retained values.
- Constrain it to `Sendable` where it crosses a thread/task boundary.
- Do **not** make its instances move-only; the whole point is aliasing.
- Resolve the "`shared` handle is a pointer" ABI in both backends.

Only after Phase C can the "struct or class?" question actually disappear.
Until then the honest pitch is: _default to `struct`; the compiler forces
`owned`, `indirect`, or `shared` exactly when the situation demands it, with the
fix named in the error._

---

## The string decision

Recommend **(1): `string` is owning**, so a struct with a string field is
`owned`, and `view string` is the cheap read-only passing form.

- It preserves "shallow copy is always sound" — the invariant that makes the
  rest of the design tractable.
- It is already the behavior for binding copies (C2); it only formalizes the
  field-default path, which should stop raw-storing.
- It keeps `owned` honest: real structs often own strings, and the compiler
  should say so rather than hide an allocation behind a plain `struct`.

Reject v1's option (2): a hidden O(n) dup on every copy of a string-bearing
struct has no marker at the copy site, which directly contradicts the opening
principle, and the bug it claimed to fix does not exist.

Leave v1's option (3) (COW) as a possible future performance change; it needs a
refcount/immutability story and cuts against deterministic destruction.

---

## Revised open questions

1. **Phase A exact rule.** Which initializer shapes count as "reading an
   existing binding" (bare name, field access, container element,
   `.at`/`.pop`)? Include each borrow form or start with the bare-name and
   field cases.
2. **`ref` binding syntax.** `ref T q = p` (prefix, matching `ref` params and
   `view`) vs. `var q = ref p`. Pick the prefix for consistency.
3. **Strict invalidation.** When, if ever, do `ref` bindings adopt `view`
   invalidation instead of lenient class-alias behavior? Flag as a breaking
   change; do not bundle into Phase A.
4. **Trait-object boxing (B4).** Implicit-on-conversion vs. a spelled `box`
   form; how boxing a `ref`/borrow interacts with the borrow checker.
5. **Phase C keyword.** Rename `class` → `shared`, or keep `class` and narrow
   its documented purpose.
6. **`indirect` + nullable owned structs.** Unify with the existing companion
   flag (`src/build_common/nullable_struct.ts`).
7. **`.copy()`** — keep as-is; explicit and out of the type system's way.

---

## Migration sketch

| Today                                             | Phase | Under the plan                                  |
| ------------------------------------------------- | ----- | ----------------------------------------------- |
| `var Box q = p` (silent alias)                    | A     | `ref Box q = p` (error without it)              |
| `func f = (Box b) { b.set(1) }`                   | A     | already `Update to const: b` — no change        |
| `class Node { var Node? next }`                   | B     | `owned struct Node { indirect var Node? next }` |
| `struct Config { var List<Log> h }` (error today) | B     | `owned struct Config`                           |
| `struct P { var string s }; var q = p` (error)    | B     | still an error → `owned struct P`, or `view`    |
| `Array<Control>` / `ClassBuffer<Control>` slots   | B     | boxed trait handles (B4)                        |
| `class Window` / `Mutex` / `Channel`              | C     | a `shared` identity type (or unchanged)         |
| `move` / `ref` / `view` / `for ref` at bindings   | A/B   | unchanged                                       |

Docs: consolidate the struct/class sections of `SPEC.md` and
`docs/MEMORY.md` into one (note: `MEMORY.md` lives at `docs/MEMORY.md`;
`AGENTS.md` references it unqualified).

## Alternatives, briefly

- **v1 as written.** Rejected: ships the risky work first, misstates the
  migration cost, and has no answer for trait objects or concurrency.
- **Only Phase A, stop there.** Legitimate. It closes the verified hole for
  little cost; B and C are genuine improvements but can be deferred
  indefinitely if the value types already in use are acceptable.
- **Keep `struct`/`class`, fix leaks only.** This _is_ Phase A. It is the
  recommended near-term scope; B/C are the longer arc.
- **Fully inferred semantics / heap-everything + GC.** Rejected, for v1's
  reasons.
