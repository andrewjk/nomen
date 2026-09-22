# STRUCT_PLAN — collapsing `struct`/`class` into one declaration form

A design proposal from a language-design review of the struct/class split.
Thesis: the two keywords bundle **one semantic axis** (copy vs move at binding
sites) with **one implementation axis** (inline vs heap placement), and Nomen's
move/borrow machinery has already made the semantic axis explicit everywhere
except two class-shaped holes. If placement is owned by the compiler and the
copy/move axis is _checked_ rather than chosen, `class` can be retired.

The property this design protects, stated once up front because every rule
below serves it:

> **Nothing aliases, copies, moves, or is edited without a marker at the point
> where it happens — and representation is never something the user has to
> guess.**

## Where we are today

Nomen effectively has three categories, not two:

| Category            | Example                     | Storage                   | Binding semantics                     |
| ------------------- | --------------------------- | ------------------------- | ------------------------------------- |
| plain value struct  | `Point`                     | inline                    | memcpy on assignment/param            |
| owning value struct | `List`, `Map`, `Buffer`     | inline bytes, heap-backed | move-only; copy is a compile error    |
| class               | `Window`, `Channel`, `Node` | malloc'd, by pointer      | reference semantics; `move` transfers |

The existing move/borrow vocabulary is already strong and mostly uniform:

- Declarations are a `"const" | "var" | "move"` trichotomy
  (`src/check/StackValue.ts:22`); `var b = move a` transfers ownership and
  invalidates `a` (`src/check/check_declaration_node.ts:436`); `b = move a`
  likewise (`src/check/check_assignment_node.ts:443`).
- Field extraction moves require a swap to revalidate:
  `var X b = move obj.field swap <rep>` (`src/check/check_declaration_node.ts:393`).
- `ref` params are spelled at **both** definition and call site
  (SPEC.md §Reference Parameters); `move` params require `move` at the call
  site (`take(move b)` — "b is invalid after this"), enforced with "Missing
  'move' keyword" (`src/check/check_function_call.ts:673`).
- `view T` bindings are spelled, non-owning borrows with full invalidation
  rules (SPEC.md §Views).
- `for ref x of arr` gives mutable loop bindings (SPEC.md §Loops).
- Returning a class value requires `move` — "would create shared reference"
  (`src/check/check_return_node.ts:73`).

The warts — all of them on the class side of the split:

1. **The Go/Swift bite exists today for classes.** `func f = (Point p)` copies
   (callee edits invisible) but `func f = (Box b)` passes a pointer (callee
   edits visible) — identical signature shape, opposite mutation visibility,
   decided by the type's class-ness. SPEC.md:380 makes classes "passed by
   pointer" with no marker at definition or call site.
2. **Silent aliasing at assignment.** `var Box q = p` is an object-level alias
   with no keyword (`src/check/check_declaration_node.ts:445`), while
   `var Point q = p` snapshots.
3. **`class` is an unchecked preference.** `class Vec2 { var int x; var int y }`
   compiles and is silently slower and aliasing-prone; no diagnostic will ever
   flag it. The struct/class choice is a free-floating judgment call made
   upfront for every type — the Swift "struct or class?" paralysis.
4. **The keyword bundles several axes.** class = heap + aliasing + `->` vs `.`
   in the backend (`src/build_c/build_struct_node.ts:94`) + different string
   field ownership (dup-on-assign for classes, raw store for value structs,
   `src/build_c/build_struct_node.ts:213-230`) + field restrictions ("struct
   fields cannot be 'ref'", value structs can't contain class/trait fields,
   `src/check/check_struct_node.ts:140-159`). Users can't predict which
   consequences follow from the choice.
5. **String ownership diverges by context.** The same `var string name` field
   behaves differently depending on the enclosing kind's class-ness.

## Proposed design

### 1. One declaration form; `struct` is the default

```nomen
struct Point {            // inline storage, always
	pub var int x
	pub var int y
}
```

Every type is a struct with inline storage. `class` is removed. There is no
placement keyword, no heap-vs-stack decision, ever.

### 2. Copyable is the _verified default_; `owned` is the escape hatch

A plain `struct` declaration **means** "this type is Copyable" — assignment,
param passing, and `var b = a` memcpy. The checker _verifies_ the claim: every
field must itself be Copyable (primitives, other Copyable structs — see
§The string question for the hard case). Verification failure is a **hard
error at the definition**, not a warning:

```
error: 'Config' cannot be Copyable — field 'history' owns heap memory
  --> mark the struct `owned struct Config`, or remove the field
```

Acknowledging moves the author to:

```nomen
owned struct Config {
	var int retries
	var List<Log> history     // owning field, fine under `owned`
}
```

`owned struct` differs from `struct` on **exactly one axis**: bindings move
instead of copy. Storage stays inline (a `List` field is a fat pointer pair of
bytes). All other machinery — access syntax, field rules, param modes,
destruction — is identical.

Properties of this polarity:

- Zero ceremony for the common case (small value types), which are also the
  perf-critical majority.
- The decision is _reactive_: users write `struct` until the compiler demands
  `owned`, with the fix in the error message. A user can write Nomen for
  months and never face the choice.
- A wrong label is impossible: the checker picks the truthful label. Compare
  `class Vec2`, which is a wrong choice no diagnostic will ever surface.
- Adding an owning field to a published Copyable struct is a loud,
  semver-honest API break (Rust's `derive(Copy)` experience) instead of a
  silent behavior change downstream.

Warnings are deliberately _not_ part of this axis. An opt-in-Copyable design
would need a "you could add Copyable" nag on nearly every struct — ignorable
warnings and ceremony on the common path. If a perf nag is ever wanted, it
belongs in a clippy-style lint ("copies 512 bytes"), not the core checker.

### 3. Self-reference is boxed, and spelled: `indirect`

A struct cannot contain itself inline; the compiler detects the containment
cycle and _requires_ the indirection to be spelled at the field:

```nomen
owned struct Node<T> {
	var T value
	indirect var Node<T>? next     // heap-indirected; required to compile
}
```

Rationale for requiring the keyword rather than inferring it silently: the
code cannot compile otherwise, so this is a forced move — but _where_ the
indirection lives is a real design decision with cache-behavior consequences
(`indirect` pointer chain vs. slab-of-indices vs. id pool), it is rare and
advanced, and keeping it visible preserves the source-text principle. This is
Swift's `indirect` and Rust's explicit `Box<` precedent. The error must name
the field that closes the cycle.

Trait-typed fields (a vtable + instance pointer — a handle to a heap object)
count as owning, so they require `owned` as well.

### 4. Parameter modes are the contract; the compiler owns the mechanism

One rule for every type — mode decides semantics, representation decides
nothing observable:

| Signature  | Call site   | Meaning                                       | Mechanism (compiler's business)                                  |
| ---------- | ----------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `T x`      | `f(x)`      | read-only; callee can't keep it, can't mutate | copy for Copyable, const-borrow for owned — whichever is cheaper |
| `ref T x`  | `f(ref x)`  | may mutate through; borrow-checked            | pointer, always                                                  |
| `move T x` | `f(move x)` | ownership transfers; source invalid           | pointer/registers; callee destroys                               |

The bare-param optimization (by-value registers vs const pointer) is sound
_because_ bare means read-only — the choice is semantically invisible. Keep it
deterministic and documented; `extern func` pins the ABI per SPEC regardless.

The crucial change from today: **bare `T x` on an owned type becomes a
read-only borrow**, not a shared mutable handle. Mutation without `ref` is a
compile error for every type, closing the class-shaped hole in
"will this be edited? is answerable from the call-site text."

### 5. Spelled aliasing: `ref` bindings

Generalize the existing borrow machinery (`borrow_depth_of` /
`borrow_owner_of`, view invalidation) from params/views to local bindings:

```nomen
ref Box q = p        // alias, spelled (replaces silent `var Box q = p`)
ref Point r = origin // interior borrow of a local, view rules apply
view v = s.slice(0, 5)   // unchanged
```

`ref` to a value struct follows the view discipline (no capture, no escape,
invalidation when the source is reassigned). `ref` to an owned struct keeps
today's lenient class-alias semantics initially (owner defers its free; the
alias survives source reassignment — `src/check/check_declaration_node.ts:445`)
so existing programs don't change behavior; unifying on strict invalidation is
a possible follow-up, flagged as a behavior change.

Result: the binding vocabulary is closed —
`const` (read/copy) · `var` (owned mutable) · `move` (transfer) ·
`ref` (alias) · `view` (borrowed slice) — mirroring the param modes, with no
way to alias without a marker at any granularity.

### 6. Make representation observable

Compile errors announce changes (Copyable violation, `indirect` requirement);
hover/diagnostics answer questions. Since a VSCode extension ships alongside,
hover should render e.g. "inline, 24 bytes, Copyable" or "inline, owned
(move-only)". The ergonomics goal is not "nothing can change" — it is "you
never have to wonder."

## Pros and cons vs the current design

**Pros**

- The Go/Swift bite class disappears: mutation visibility is decidable from
  the signature and call-site text alone, uniformly for every type.
- No "struct or class?" decision, ever; no unchecked `class Vec2` choices.
- Silent aliasing (`var Box q = p`) and shared mutable handles (bare class
  params) — today's two unmarked-aliasing leaks — are closed.
- Five consequences bundled into `class` collapse to one axis (`owned`),
  so documentation, learning, and compiler freedom all improve.
- Field restrictions dissolve: any struct may contain any struct (owning
  fields just force `owned`); the special cases in `check_struct_node.ts`
  become one mechanical rule.
- The backend's `->` vs `.` duality and the class/struct constructor split in
  `build_struct_node.ts` reduce to one shape with compiler-inserted
  indirection.
- String-ownership divergence (§Where we are today, item 5) must be resolved
  into one rule.

**Cons**

- A large migration: every `class` in `core/` and user code is rewritten;
  the biggest behavioral change is bare class params becoming read-only
  (code that mutated through them must adopt `ref`, spelled at call sites).
- Two new keywords (`owned`, `indirect`) and one new binding form (`ref`
  bindings) — though `class`'s retirement is a net keyword reduction.
- ABI becomes analysis-derived post-monomorphization (Rust proves it's
  tractable; it is real work in both backends).
- Class-alias leniency vs view strictness is a live inconsistency until
  reconciled (§5).

## Performance issues and gotchas

- **Inline-by-default is load-bearing.** The benchmark suite depends on it —
  `Body[5]` arrays of inline structs feed the fixed-array access pipeline
  (`docs/scratch/ASM_PLAN_3.md`, `bench/nomen/nbody.nm`). Boxing must happen
  _only_ where structurally forced (self-reference, trait objects), never as a
  perf guess. Escape analysis may optimize, but must never be what stands
  between the user and a `malloc` in a hot loop (the Java-before-Valhalla
  trap).
- **The accidental-boxing hazard is neutralized by construction**: boxing
  requires the author to write `indirect`, so a field change cannot silently
  flip a type's representation. There is exactly one announcement event, at
  the definition — call sites don't independently "become boxed."
- **Copyable copies are shallow by definition.** A Copyable struct containing
  a `List` is impossible (it would be `owned`), so shallow memcpy never
  duplicates a backing store. This is what makes the string question (below)
  the only deep-copy decision in the design.
- **`owned` default is move-only, so passing owned values without `move`/`ref`
  costs nothing extra** (const borrow), but watch for code that previously
  relied on free class-pointer copying; those sites become explicit moves.
- **Monomorphization order**: representation (inline vs indirected) is
  per-instantiation; generic structs containing generic fields need the
  existing mono machinery to settle layouts before body emission — same class
  of ordering the `Array<T>` materialisation work already solved
  (`docs/ARRAY.md`).

### The string question (biggest open design decision)

`string` is a fat `(ptr, len)` pair — Sized, but owning and _mutable in place_
(`string_mutation_scan.ts` exists because of this). Whether `string` counts as
owning decides whether `owned` is rare or everywhere: almost every real struct
has a string field. Options:

1. **String is owning** → `struct P { var string name }` must be `owned`.
   Truthful, but `owned` stops being rare and the ergonomics claim weakens.
2. **String fields dup on copy** (today's _class_ behavior, generalized):
   Copyable structs with string fields dup the bytes at copy time. `struct`
   stays common; copies of string-bearing structs pay a hidden O(n). Matches
   existing class-field behavior, so migration is a flip of the _value-struct_
   side (which raw-stores today — an aliasing bug waiting to happen, since
   both copies would free the same bytes).
3. **COW strings** (Swift's answer): cheap copies, dup on first write. Needs an
   immutability/refcount story in a single-owner, malloc-based model — the
   largest implementation lift, and refcounts cut against the deterministic-
   destruction design.

Recommendation: (2), with the dup cost visible in repr diagnostics, and
`view string` pushed as the read-only passing form. Today's value-struct raw
store is the status quo that should _not_ survive.

## Alternatives considered (briefly)

- **Keep `struct`/`class`**, fix only the leaks (require `ref`/`move` on bare
  class params, spell class aliases). Smaller migration, but keeps the
  unchecked per-type decision, the bundled axes, and the backend duality.
- **Opt-in `Copyable` + warning-if-missing.** Rejected: warnings on nearly
  every struct train users to ignore them, and ceremony lands on the common
  case. The need for the nag is the argument against the polarity.
- **Fully inferred semantics** (the original prompt: Sized analysis decides
  copy vs share). Rejected: semantics flips become non-local and
  version-fragile — adding a field silently changes `var b = a` at every use
  site. Placement may be inferred because it is unobservable; semantics may
  not, because it is observable.
- **Heap-everything + GC** (Java model). Rejected: contradicts deterministic
  destruction, the malloc-based memory model, and the benchmark profile.

## How currently working code changes

| Today                                                         | Under the proposal                                        | Notes                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `class Node { var Node? next }`                               | `owned struct Node { indirect var Node? next }`           | mechanical; `indirect` required by cycle check                                             |
| `class Window` / `Channel` / `Mutex`                          | `owned struct Window` …                                   | they're `owned`, not "heap" — placement unchanged in practice                              |
| `struct Config { var List<Log> h }` (compiles today)          | compile error → `owned struct Config`                     | the one new author decision, forced and explained                                          |
| `var Box q = p` (silent alias)                                | `ref Box q = p`                                           | spelling only; semantics preserved (lenient alias)                                         |
| `func f = (Box b) { b.set(1) }` … `f(bx)`                     | error: mutation needs `ref` → `(ref Box b)` + `f(ref bx)` | the big behavioral change; every mutation-through-bare-class-param is surfaced             |
| `func f = (Box b) { Console.write(b.desc()) }`                | compiles unchanged                                        | bare owned param is now a _defined_ read-only borrow instead of an undefined shared handle |
| `struct P { var string s }; var q = p`                        | raw alias today; dup under option (2)                     | behavior change, and a bug fix — see §The string question                                  |
| `class`-typed struct fields in value structs (today an error) | legal under `owned`                                       | restrictions collapse into the Copyable check                                              |
| `move`/`ref`/`view`/`for ref` at bindings                     | unchanged                                                 | already the target vocabulary                                                              |

Existing tests that encode current class behavior (`test/mov_ownership.test.ts`,
`test/list.test.ts` class cases, spec examples around SPEC.md:380) need
rewriting, and `SPEC.md`/`MEMORY.md`/`NOMEN_AGENTS.md` struct/class sections
consolidate into one.

## Current issues this would prevent

- **The Go/Swift bite** (mutation visibility decided by type implementation,
  invisible at the call site) — closed for classes by §4.
- **Silent aliasing** (`var Box q = p`, `src/check/check_declaration_node.ts:445`)
  — closed by `ref` bindings.
- **Unchecked slow/aliasing choices** (`class Vec2`) — impossible; the checker
  assigns the truthful label.
- **Value-struct raw-store string aliasing** (two copies freeing one buffer)
  — resolved by the string decision.
- **The struct/class field-restriction error zoo**
  (`src/check/check_struct_node.ts:140-159`) — collapsed into one rule.
- **`->` vs `.` backend duality and class/struct constructor duplication**
  (`src/build_c/build_struct_node.ts:94, 325`) — one lowering shape.
- **Decision paralysis / docs burden**: "struct or class?" stops being a
  chapter in every tutorial and a question in every beginner's head.

## Open questions

1. String semantics (§The string question) — decide before anything else; it
   determines how common `owned` is.
2. Trait-typed fields: owning (forcing `owned`) vs. a special nullable-slot
   carve-out — owning is simpler and probably right.
3. `ref` binder syntax placement (`ref Box q = p` vs `var q = ref p`) — pick
   one and apply it consistently to `view` as well.
4. Whether class-alias leniency survives, or `ref` bindings unify on strict
   view-style invalidation.
5. Nullable owned structs (`T?` where T is `owned`): companion-flag form
   already exists for non-class structs (`src/build_common/nullable_struct.ts`);
   unify class optionals onto it.
6. `Copy` deep-dup escape hatch (`.copy()` exists for owning types today) —
   keep as-is; it is explicit, spelled, and out of the type system's way.
