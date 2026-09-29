# STRUCT_PLAN_3 — structure, not sharing

A third revision of the struct/class plan, from a design review of
[`STRUCT_PLAN_2.md`](./STRUCT_PLAN_2.md). Phases A and B of v2 survive with two
renames; its Phase C — a `shared struct` reference tier carried by hidden
refcounts — is **dissolved entirely**. Concurrency lifetimes are made static by
structure (nurseries) instead of dynamic by counting, the identity tier is
replaced by the handle pattern the codebase already uses internally, and
`class` retires without a successor keyword.

The property the whole design serves is unchanged since v1:

> **Nothing aliases, copies, moves, or is edited without a marker at the point
> where it happens — and representation is never something the user has to
> guess.**

## TL;DR

| Phase | Scope                                                                                                                                         | Risk   | Gate          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------- |
| **A** | Spell class aliases (`ref` bindings). No representation change.                                                                               | Low    | none — do now |
| **N** | Align with the shipped async model (`docs/ASYNC.md`): checked region borrows, daemon move-only rule, `WeakHandle<T>`, protected-slot sharing. | Medium | Phase A       |
| **B** | Unify value types: `struct` / `owning struct` / `Box<T>`, string rule, trait-object boxing.                                                   | Medium | Phase A       |
| **R** | Retire `class`. Every use site becomes an `owning struct` plus `ref` / `Box` / `WeakHandle` shapes.                                           | High   | N + B4        |

## Decisions locked in this revision

Recorded with their one-line rationale, since the review that produced them was
long.

### D1. `owning struct`, not `owned struct`

The declared fact is about the **type**: it owns heap resources — which is what
`is_owning_struct_type` (`src/check/utils/ownership.ts:159-161`) already asks
and what the error message says ("field 'history' **owns** heap memory").
"Owned" parses as "a struct that is owned," which is vacuous in a single-owner
model: every instance is owned by its binding. "Owning" also matches the
dialect the codebase and both prior plans already speak — "owning field,"
"owning value struct" — at both levels: an `owning struct` owns its owning
fields.

### D2. `Box<T>`, not `indirect`

v1 §3's real requirements were: boxing is **forced, not inferred** (the
compiler errors until it is spelled, naming the field that closes the cycle),
and the indirection is **visible at the declaration**. A library type satisfies
both — the spelling lives in the type:

```nomen
owning struct Node {
	var int value
	var Box<Node>? next
}
```

- **Zero new grammar.** `indirect` would be a new syntactic category (a storage
  qualifier on fields), touching parser, checker, and both backends' layout
  rules. `Box<T>` is an owning struct with one pointer field; it rides the
  existing owning-field machinery (destroy dispatchers, swap extraction) that
  `List` fields already use. Its magic is the same tier Nomen grants library
  types today: known-name constructor, destroy = destroy-pointee + free,
  transparent field/method access through the box — the `List`/`Buffer`/
  `string` tier.
- **It generalizes for free.** `indirect` is field-shaped; `Box` works anywhere
  a type works — locals (`var Box<Config> cfg` covers B2's stable-address
  reason), containers (`List<Box<Node>>`), detach captures. Shipping the
  keyword would eventually require inventing `Box` anyway: two mechanisms, one
  idea.
- **Nullability collapses.** `Box<Node>?` is a null pointer — the natural null
  slot, no companion flag (`Option<Box<T>>` in Rust).
- **The checker story is identical.** Cycle detection walks field types either
  way; the error prescribes a type change: _"field 'next' closes an inline
  containment cycle — declare it `Box<Node>`."_ Nothing boxes silently.
- **It completes the handle pattern** (see §The handle pattern).

### D3. String is owning

v2's recommendation, confirmed. `string` is a fat `(ptr, len)` pair that owns
its bytes and is mutable in place; a struct with a string field is `owning`,
and `view string` is the cheap read-only passing form. This preserves "shallow
copy is always sound" — the invariant that makes the rest of the design
tractable — and formalizes what `is_owning_struct_type` already enforces for
binding copies (v2 C2). The field-default path should stop raw-storing.

### D4. No `shared` tier, no refcounts

v2's Phase C is rejected. Hidden refcounts contradict the marker principle
(runtime aliasing with no marker at the binding), leak cycles, and put atomic
traffic on every binding copy. The expressiveness is recovered statically —
see §Why no reference tier.

### D5. Detach owns its captures

A detached task must own everything it touches: `move` captures and Copyable
copies only. Capturing anything with a lexical owner is a compile error. See
§N2.

### D6. `WeakHandle<T>` is a library type, not a keyword

The residue of OS/AppKit retention gets a core type alongside `Mutex` and
`Channel`, not a new modifier. See §N3.

---

## Why no reference tier (the argument, in order)

1. **The theorem.** Under deterministic destruction, a value whose lifetime is
   shared across holders needs one of: a lexical proof that all other holders
   are dead, a runtime count (refcount), or "nobody ever frees it." There is no
   fourth option.
2. **v2 assumed the lexical proof cannot span concurrency** ("two workers hold
   the same lock") and therefore chose the refcount. That assumption is wrong
   for _structured_ concurrency: a nursery's join barrier converts concurrent
   lifetimes back into a lexical region. Inside the nursery, workers may borrow
   the same lock; at the barrier they are provably done; the owner frees
   lexically. "Who is last" is always statically answerable: the owner outside.
3. **Handle fields fix placement, not aliasing.** v2's C3 correction stands —
   `Mutex`/`Window` keep their real resource behind an integer/pointer handle
   field, so moves of the struct are safe because the resource does not move.
   But sharing still needs either a copy (two owners → double-close), a
   borrow (lexical), or a lifetime protocol (the theorem). Nurseries supply the
   lexical proof; the handle supplies move-safety. Neither needs a count.
4. **The residual is small.** Only _unstructured_ escape remains: OS callbacks
   that outlive a region (AppKit delegates racing a close), and detached work
   that must rendezvous. §N gives each a spelled, refcount-free answer.

A corollary worth stating: today's class aliasing is _already_ lexical-only —
the owner defers its free past live aliases
(`src/check/check_declaration_node.ts:324`,
`src/build_c/build_assignment_node.ts:718`), and those deferral maps know
nothing about threads. A class instance captured by a worker today is a latent
use-after-free unless the code joins before the capturing scope exits. Nursery
discipline does not remove expressiveness; it formalizes what correct code
already requires.

## The handle pattern

One pattern explains every "identity" type and replaces the reference tier:

| Type               | Is                                                      |
| ------------------ | ------------------------------------------------------- |
| `Box<T>`           | a handle to **your own value** (pointee survives moves) |
| `WeakHandle<T>`    | a handle to a **registry slot** (checked, may be gone)  |
| `Mutex` / `Window` | a handle to a **kernel / ObjC object**                  |

An owning struct with a handle field is movable, single-owner, deterministically
destroyed, and FFI-safe. The thing v2 called an identity tier was never a new
kind of type — it was this pattern plus _sharing_, and sharing is now
structure's job (§N1).

---

## Phase A — spelled aliases (do now)

From v2 §Phase A with its open questions resolved (§Decisions below);
reproduced here so this document stands alone.

**Goal.** Close the one verified hole: `var Box q = p` aliases silently.
Nothing about layout, traits, concurrency, or the `struct`/`class` split
changes.

**The binding vocabulary, by position:**

| Position          | read-only / owned            | alias / borrow             | transfer                  |
| ----------------- | ---------------------------- | -------------------------- | ------------------------- |
| params            | bare `T x`                   | `ref T x` (mutable borrow) | `move T x`                |
| locals (before A) | `const x`                    | `view x` (slice only)      | `move x`                  |
| locals (after A)  | `const x`                    | `ref x` / `view x` (slice) | `move x`                  |
| fields            | `const` / `var` / `readonly` | `view T` (slice only)      | `var` + owning type (§B5) |

- **Params are already complete.** Bare is read-only (v2 C1: bare params are
  `const` for every type — `check_function_parameter_node.ts:81`,
  `check_access_node.ts:732`), `ref` is a spelled mutable borrow, `move`
  transfers.
- **Locals gain `ref`** — the general 8-byte alias that `var Box q = p`
  performs silently. `view` stays a `(ptr, len)` slice borrow.
- **Fields can transfer, but not borrow.** `ref T` fields stay rejected
  (`check_struct_node.ts:137-144`): a field lives inside a value that can
  outlive its source, so an unchecked pointer field is the use-after-free the
  language exists to prevent. A struct that must point at another object uses
  `Box` (owned) or `WeakHandle` (checked back-pointer / OS-retained).

**Rule.** A declaration whose initializer reads an existing binding or a field,
and whose type is a reference type, must say what it is doing:

```nomen
ref Box q = p          // alias, spelled; owner defers its free
move Box q = p         // transfer; p is invalid afterwards
var Box q = p.copy()   // deep copy (owning types)
var Box q = Box(0)     // fresh temporary: unchanged
var Box q = make()     // fresh owned return: unchanged
```

`var Box q = p` becomes `error: 'p' is aliased — use 'ref' to share it,
'move' to transfer it, or '.copy()' for a deep copy`.

**Semantics (deliberately status-quo).** `ref` keeps the lenient class-alias
behavior: the owner defers freeing its old instance on reassignment; mutation
through the alias is visible and expected (it is spelled now); mutation through
a `ref` requires the source to be `var`; a `ref` binding is not reassignable.
Strict view-style invalidation is deferred until after Phase N (A6 below).

**Implementation surface.** Parse the `ref` binding form (mirroring the `view`
normalization in `check_declaration_node.ts:62-89`); at
`check_declaration_node.ts:445`, replace the silent `class_alias_of` fallback
with an error unless the binding is `ref`/`move`; set `borrow_depth`/
`borrowed_from` (or the lenient `class_alias_of`) from `utils/borrow.ts`.
Codegen is unchanged.

**Tests.** `test/mov_ownership.test.ts`, `test/swap.test.ts`, class cases in
`test/list.test.ts`; error tests for the unspelled form.

### Decisions (resolved)

**A1. Trigger predicate: semantic, shipped minimal-first.** The final rule is
semantic — _the initializer aliases iff the produced value is owned
elsewhere_. Implementation: bare identifiers and field chains trigger by
syntax (what the `class_alias_of` path at `check_declaration_node.ts:445`
already detects, so the core rule is nearly free); calls trigger iff the
method is classified borrow-returning (the existing view-style method table,
extended with a transfer classification so `pop`-style extraction is exempt).
Ship the syntactic subset as A; container-element triggers (`list.at(i)`)
land as **A.1** once at-vs-pop classification is pinned. A syntactic-only
rule left standing would be evadable (`var Control c = controls.at(0)`), so
A.1 is a completion, not an option.

**A2. Prefix syntax.** `ref Box q = p`, matching `ref` params, `view`, and
the existing `const`/`var`/`move` prefix slots. The postfix form
(`var q = ref p`) would make `ref` an expression operator — address-of
semantics, `f(ref x)` collisions, `ref p.field` rules — a much larger grammar
for no gain.

**A3. Mutation rules.**

1. Mutation through a `ref` requires the source to be `var`:
   `error: cannot mutate through 'q' — source 'p' is not var`.
2. A `ref` binding is not reassignable:
   `error: 'q' is a ref — reassign the owner, not the alias`. Re-pointing an
   alias under deferred-free semantics is where the model becomes
   incoherent; a `ref` is "another name for it, for this scope" — a const
   pointer.
3. No `move` through a `ref` — the alias is not the owner:
   `error: 'q' is a ref — move the owner instead`. `ref` can mutate, never
   transfer.

**A4. Scope: reference types only.** `ref Point r = origin` (interior borrow
of a value-struct local) is not in A; the borrow vocabulary stays `ref` =
object alias, `view` = `(ptr, len)` slice. `for ref x of arr` unifies with
rule 1 of A3: a mutable loop binding requires a `var` source, same error
shape.

**A5. Lenient classification, codegen unchanged.** A `ref` binding to a
reference type reuses `class_alias_of` (owner defers free; both backends
already classify the alias syntactically). The `borrow_depth`/`borrowed_from`
route is the strict future (A6), not the A present.

**A6. Strict invalidation: deferred, trigger named.** `ref` adopts
view-style invalidation (source reassigned → checked use-after-invalidation)
only after **Phase N**, whose region/capture tracking is exactly the
machinery strict `ref` needs. Until then, lenient semantics equal today's
class behavior; no existing code changes.

Error-message tailoring: the unspelled-alias error suggests `.copy()` only
for owning types that have it; pure reference types list `ref`/`move` only.

---

## Phase N — structure for concurrency

Lands in the `class` world and does not depend on Phase B. It removes the
reason a reference tier was thought necessary.

### N1. Nurseries: shipped — align, don't rebuild

The `nursery { spawn … }` sketches in earlier drafts were stale: `spawn` left
the language when the async migration landed (`docs/ASYNC.md`, shipped on both
backends):

```nomen
async {
	var t1 = Thread(fetch_users(id)).start()
	var t2 = Thread(fetch_orders(id)).start()
	const users = t1.result()
}
```

- `async { … }` is the nursery: unconditional join at the closing brace,
  before block locals are destroyed. `async pool { }` names a `Nursery` for
  the Trio escape hatch (`pool.start(Thread(f(x)))`); `async(timeout: N)` and
  `async(mode: race)` give cancellation scopes. `Thread(...).start()` /
  `Fiber(...).start()` are real library methods over `Spawnable<T>` with the
  `#spawn` construction hook; constructions are storable with must-start
  `#destroy`; `Task<T>` is the unified handle (`wait`/`result`/`cancel`/
  `is_done`), reference-counted so join-once holds. Cancellation is ambient
  (`Task.current_cancelled()`), cleanup rides `#destroy`, and total deadlock
  aborts with a wait-graph dump.
- The shipped capture rule: spawn arguments are owned by the task env
  (strings deep-copied, owning value-structs env-copied, donors not moved),
  and class/trait arguments are shared pointers gated by the `Sendable`
  trait. The original nursery-borrow exception (a join-bounded class borrow)
  was retired as unchecked.
- **The struct-world change**: with `class` retired, the `Sendable` alias
  gate loses its subject — an `owning struct` cannot alias. Two workers
  sharing one lock re-legalize the borrow exception, but **checked** this
  time: a borrowed spawn argument must be join-bounded (its root is declared
  before the `Thread(…)` construction, in a scope enclosing the `async`
  block), is read-only by default, and mutates only through protected slots
  (§N4). This is Rust's scoped-thread discipline with the borrow machinery
  Nomen already has (`borrow_depth_of`/`borrow_owner_of`). The reason the
  exception was retired — "a quieter path past `Sendable`" — dissolves,
  because `Sendable`-on-classes is itself retired by Phase R.
- Errors need no propagation model (closing an `ASYNC.md` open question):
  errors are `must_use` enum values, so a failing worker's error is the
  task's return value, delivered by `Task<T>.result()` and forced into a
  `switch` by `must_use`. There is no unwinding to spread; `panic` stays an
  abort.
- **The runloop is the root nursery.** For GUI apps the app runloop ("run
  until quit") is the outermost region; "fire and forget" from an inner
  block is `pool.start(...)` into the app-level nursery, which still joins
  at quit.

### N1a. Checked region borrows — the rule set

Decided (R1–R4). The rules fire at the `#spawn` construction, where arguments
are evaluated and packed eagerly.

**R1. Capture classification.**

| Argument                          | Packing                               | Region check |
| --------------------------------- | ------------------------------------- | ------------ |
| Copyable type, bare               | env-copy (today's behavior)           | no           |
| Owning type, bare                 | const borrow (pointer in env)         | **yes**      |
| Owning type, `move x`             | transfer — task owns, destroys at end | no           |
| `view`-typed                      | borrow of its source                  | **yes**      |
| class/trait (transition era only) | alias + `Sendable` (shipped)          | until R      |

Bare-on-owning is forced: owning types cannot be copied, and the parameter
table already defines bare = const-borrow. This retires today's env deep-copy
of owning arguments — sound but silently expensive (a `List` copy per spawn)
— with identical visible semantics: the donor keeps access, the task reads.

**R2. The lexical region rule.** A borrowed capture's **root** (the local at
the base of the access path — `m` in `m`, `holder` in `holder.field`) must be
declared **before the construction, in a scope that encloses the `async`
block's closing brace**. One condition covers every case: outside the block ✓;
inside the block before the construction ✓ (its region ends after the join);
declared after ✗; a loop-local whose iteration ends first ✗; params and
globals ✓. Moved and copied captures are exempt — ownership has no region.

**R3. The freeze.** From the construction until the enclosing `async` block
exits, a borrowed root is **const**: body reads fine; writes, moves, and
mutable-passing error; multiple const borrows (two workers) fine; `with(m)`
stays legal for shareable types (lock-mediated mutation is the sanctioned
path). Without the freeze the body races its own workers. Checker-side only —
`borrow_depth_of` at region scale, unfrozen after the join. Adjacent rule: a
construction created inside an `async` block must be `.start()`ed inside it —
tasks belong to the scope that created them.

**R4. Detach tightened now** (§N2): the move-only rule lands up front,
including the transition era — a `Sendable` class argument to a daemon
becomes an error immediately, fixing the live dangle.

Error texts:

```
error: 'm' does not outlive the task — the join at 'async' happens after
  'm''s scope ends; declare 'm' earlier, or move it in ('move m')
error: 'm' is borrowed by a task until this 'async' block exits — it is
  read-only here (mutate through with(m), or move a copy in)
error: detached tasks own their captures — 'm' must be moved ('move m'),
  not shared
error: this Thread(...) must be started inside its 'async' block — tasks
  belong to the scope that created them
```

**Implementation surface.** The `#spawn` construction path in
`check_function_call_node` classifies each argument; freeze tracking is a
scope-ordered map (declaration order the checker already has); codegen for a
borrowed owning argument is exactly today's class-argument path — store the
pointer, the env does not own it — in `build_magic_ctor`, minus the destroy.

### N1b. Closure captures: the env owns

Decided (E1–E4). The shipped lambda machinery (`docs/CLOSURE.md`, "Capture
kinds") already provides the rule; this section formalizes it as permanent.

**E1. The form split is the sharing choice.** The lambda env is a
compiler-generated **owning struct**, so the closure form is self-contained
by construction — no borrows exist in lambda positions (rejected in general
positions, CLOSURE.md), no region checks, no freeze, detach-safe
automatically:

| Form                | Captures                                                                                                               | Role              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `Thread(() => …)`   | env **owns**: Copyable captured by copy, owning captured by **move** (donor invalidated), borrows/views not capturable | ownership         |
| `Thread(worker(x))` | arguments follow §N1a's classification                                                                                 | sharing (or move) |

Owning the env vs borrowing arguments is visible at the call site. Capturing
lambda values stay move-only (copying would share the env); capture-free
lambdas copy freely.

**E2. Post-R capture kinds.** "Class instances, class-backed trait
references" become "trait handles (boxed `(vtable, instance)`) — moved";
everything else in the shipped table is unchanged. One behavior change falls
out of D3: **string captures move** once `string` is owning — today they
deep-copy (`string` is a primitive), post-R `() => greet(name)` invalidates
`name`, exactly like any owning capture today.

**E3. Tighten the call-form env now.** The open question's UAF lives in the
call-form env, not the lambda env: class/trait arguments today stay shared
pointers (`build_magic_ctor.ts:133`) gated by `Sendable`, which checks
aliasability but not region — an argument whose donor dies before the join
(declared inside an inner block of the `async` body) dangles today. Fix
lands **now**, mirroring R4's spirit: §N1a's R2 root rule applies to
class/trait spawn arguments in the transition era — a `Sendable` argument
whose root does not join-bound is an error. The lexical check rides the
existing `Sendable` validation site.

**E4. The opaque-closure string leak** (a moved func-typed local or named
function: the result is duplicated and the original leaked —
leak-never-dangle, bounded at one per run) stays a flagged FOLLOWUP. D3 does
not fix it automatically — it lives in the adapter's result-dispose path;
revisit at R, when strings are owning.

### N2. Detach: the shipped daemon form, tightened

`.detach()` exists: `Thread(flusher(out)).detach()` runs a daemon on its own
pthread — never joined, killed at process exit by design. The shipped
argument rule ("args must be `Sendable`, exactly like `.start()`") hides a
dangle: a `Sendable` **class** argument is a shared pointer, a daemon has no
join to bound the alias, and the donor's scope exit frees the instance
beneath it. The rule tightens **now**, not at Phase R — it fixes a live
dangle, and daemons are rare:

> **A detached task owns its captures**: `move` arguments and copied values
> only. A protected-slot borrow is a nursery-bound luxury — a daemon has no
> region for the borrow checker to lean on.

Enforced at the `.detach()` boundary, the same shape as the "Missing 'move'
keyword" check (`check_function_call.ts:673`):
`error: detached task captures 'c' by reference — detach owns its captures;
move it, or spawn it into a nursery that outlives the use`. The task destroys
its captures when it ends — the callee-destroys contract at a non-lexical
time, deterministic in sequence. Results are discarded (want values back →
`Channel`). The rendezvous case: own the channel at app scope and
`pool.start(...)` into the app nursery, or accept an explicitly
app-lifetime channel. `.start()` = bounded and joined; `.detach()` =
unbounded and owned — both say so at the call site.

### N3. `WeakHandle<T>`

For OS-retained values and back-pointers (AppKit delegates racing a close,
child→parent edges). An owning struct with a handle field:

- **Move-only, created explicitly:** `var WeakHandle<Window> w =
window.weak()`. The _creation_ is the marker; nothing aliases without one.
- **`.get() -> Window?`** forces the nil check at the use site. The race is
  inherently dynamic (the OS may have torn the object down), so the runtime
  check is the only truthful one.
- **No refcounts.** Implementation is an id + generation slot table:
  `weak()` registers a slot, the type's `#destroy` bumps the generation,
  `.get()` compares and returns nil on mismatch. Only opted-in types
  (AppKit control wrappers) need slots. The nullable return rides the existing
  companion-flag machinery (`src/build_common/nullable_struct.ts`).
- **Registry (decided): one global table, opt-in, content-keyed runtime.**
  A single process-wide slot table `(pointer, generation)` with a free-list,
  internally synchronized — weak handles are consulted from workers, so it
  sits in the same family as the async runtime's registries. Per-type
  registries buy nothing at AppKit-scale volumes (dozens–hundreds of
  controls, not millions), and type safety rides `WeakHandle<T>`'s
  parameter, so no per-type tables are needed. Runtime emission follows the
  shipped async pattern: keyed on body content, never a type-name list.
  Documented boundary: WeakHandle tracks the **Nomen wrapper's** lifetime —
  the `#destroy` that releases the ObjC object — not AppKit's internal
  retain graph.
- **In fields:** `var WeakHandle<Window> parent` is the sanctioned
  child→parent shape once `class` retires (§Retiring `class`).

### N4. Captures at the boundary: reads, moves, and protected slots

Race discipline at the spawn boundary, orthogonal to lifetime (which N1 owns).
Captures split on _how_ they cross; the two vocabulary items are two sides of
one mechanism.

**Shipped note.** `Sendable` exists today as a marker trait (auto-derived for
structs whose fields are all Sendable; classes opt in) gating class/trait
arguments that alias across spawns — ASYNC.md's tier 3, with hand-locked
`Mutex` ("error-prone… no compiler help") as the mutable case. This section is
the endgame that replaces it: the protected-slot rule turns "trust the marker
and the lock discipline" into derived, checker-enforced sharing, and
`Sendable` retires with `class` as transition scaffolding.

- **Borrowed captures are read-only by default.** Mutation through a borrowed
  capture is an error:
  `error: cannot mutate 'c' in a spawned worker — field 'n' of 'Counter' is an unprotected primitive; wrap it in Atomic<int> or guard the struct in Mutex<T>`.
  A plain struct cannot be raced: the race attempt is a mutation through a
  shared borrow, and that is a compile error.
- **Sharing is spelled at the field; shareability is derived.** There is no
  `shareable` modifier. Protected slots are _types_: `Atomic<T>` (lock-free
  primitive operations) and `Shared<T>` (a lock-guarded slot, reachable only
  through the owning lock's critical-section form). A type may be mutated
  through cross-worker borrowed captures iff **every `var` field is a
  protected slot** — `Atomic<T>`, `Shared<T>`, or a handle. The derivation
  forces the honest spelling; a plain `var T value` would make `Mutex`
  itself un-shareable:

  ```nomen
  owning struct Mutex<T> {
  	var Handle lock     // protected slot: synchronized by contract
  	var Shared<T> value // protected slot: lock-guarded
  }
  ```

  The error lands at the share site and names the field:
  `error: cannot mutate 'c' in a spawned worker — field 'n' of 'Counter' is
an unprotected primitive; wrap it in Atomic<int> or guard the struct in
Mutex<T>`. The declaration ladder stays two rungs (`struct` /
  `owning struct`).

- **Why derivation is safe here** when v1 rejected inferred copy semantics:
  inferred _permissions_ change no existing use site's behavior — an
  un-shareable struct that gains an `Atomic` field merely becomes legal to
  share, like gaining a method — whereas inferred copy/move semantics would
  silently rewrite `var b = a` everywhere. Read-only `const` fields are
  always shareable; only unprotected _mutable_ state blocks.
- **Trust, per slot.** Residual trust is confined to one contract — _access
  through a handle or atomic is synchronized_ — the same trust Rust's std
  places in the kernel. Handles double as the escape hatch for "trust my
  internals" types: a striped lock wraps its state in one `Handle`, which
  qualifies.

- **Lock discipline is structural, not convention.** A bare
  `lock()`/`unlock()` pair is checker-invisible. User code gets `Mutex<T>`
  plus a critical-section form (Nomen has lambdas); the `Shared<T>` slot is
  reachable only through it:

  ```nomen
  with(m) (T g) { g.count = g.count + 1 }
  ```

  The guarded value is scope-bound by checker rule — no storing in a field,
  no returning, no re-capturing into a spawn (the rule family that already
  rejects `ref` fields) — and deterministic destruction releases the lock.
  Every mutation of shared state happens inside a critical section the
  checker can see, which makes the read-only default sound rather than
  aspirational. The bare lock/unlock `Mutex` remains the `core/` primitive
  the typed one is built on; `Shared<T>` starts as an internal slot type
  (multi-slot guarded structs come later, if needed).

- **Trait handles are not shareable (initially).** Sharing a
  `(vtable, instance)` handle by ref is open-world — conformers arrive later,
  so safety cannot be verified — and it is rare (UI objects are
  main-thread). Move them (`Sendable` rules) or wrap them in `Mutex<T>`.
  This keeps the whole rule checker-enforced.
- **`Atomic<T>` joins core** as a new built-in with both-backend magic; a
  shared mutable counter needs it, since an unprotected primitive field
  blocks shareability.
- **Moved captures need no `Sendable` marker — the question dissolves.**
  Rust needs `Send` because of refcounts (`Rc`), escapable guards
  (`MutexGuard`), and open-world conformer sharing. This design has none of
  those: no refcounts exist, guards are scope-bound, and a moved value gives
  the task sole ownership — so **every legal move is a legal boundary
  crossing**. Boundaries (spawn capture, detach capture, channel send) reuse
  the parameter vocabulary: bare capture = read-only (copy for Copyable,
  const-borrow otherwise), `move x` = transfer with source invalidation.
  Trait handles move fine (sole access is race-free); they are only barred
  from _sharing_ (above). `WeakHandle<T>` moves freely; its registry is
  core-owned and internally synchronized.
- **Region-bound types.** A struct with `view` fields is a disguised borrow —
  moving one across a spawn or channel would smuggle the borrow past its
  region. Rule: `view`-bearing types may move only within the view's region
  and cannot cross a spawn/detach/channel boundary. Channel payloads must be
  moves (owned or Copyable), never views or `ref`.
- **Affinity is a library contract, not a type property.** "NSWindow must be
  touched from the main thread" is main-thread affinity — orthogonal to
  sendability, undetectable at the type level, and left to the AppKit
  wrapper's documented contract, same as Cocoa and Rust today.

---

## Phase B — unify value types

### B1. `struct` is the default; `owning struct` is the verified escape hatch

Bare `struct` **means** Copyable; the checker verifies every field is Copyable
and fails at the definition otherwise:

```
error: 'Config' cannot be Copyable — field 'history' owns heap memory
  --> mark the struct `owning struct Config`, or remove the field
```

`owning struct` differs on exactly one axis: bindings move instead of copy;
storage stays inline. Document the user-visible meaning as **move-only / not
Copyable**, and state plainly that converting a class to `owning struct`
changes it from a shared reference to a single-owner move. Ownership becomes
**declared and verified**: `is_owning_struct_type` stops inferring from
fields and reads the declared flag; the field walk becomes the **verifier**
implementing the predicate below.

**The Copyable predicate (closed list).**

Copyable:

- primitives
- fixed arrays `T[N]` — inline storage, copy = element-wise; sound iff `T`
  is Copyable
- value structs whose fields are all Copyable (transitive)
- `func` types — capturing closures are move-only _values_ of a copyable
  _type_; the shipped assignment-time rule ("this closure captures — the
  target must be owning") catches the unsound store, so the predicate stays
  type-level
- enums whose payload cases are all Copyable
- `view T` fields — a view is a `(ptr, len)` pair; a struct holding one
  copies the pair and is **region-bound** (§N4), but not owning (Rust's `&T`
  is Copy too)

Owning (never Copyable): `string`; `owning struct`s; `Box<T>`; trait handles;
`Atomic<T>` / `Shared<T>`; `WeakHandle<T>`; enums with any owning payload.
`Handle` stays integer-like Copyable — the _enclosing_ owning struct's
`#destroy` closes the resource.

**Migration.** Built-ins become declared: `List`, `Map`, `Buffer`, `Channel`,
`Mutex`, `Thread`, `Fiber`, `Task`, `Box`, `WeakHandle`, `Atomic`, `Shared` →
`owning struct`; `string` is marked owning in the built-in type table.

### B1a. Enums join the ladder

`enum` = Copyable, checker-verified; **`owning enum`** = move-only. Same
semver argument as B1: without the modifier, adding an owning payload to a
published enum silently flips Copyability at every use site. Anonymous enums
(`[.ok(T), .error]`) stay derived — they are local, no API surface.

```
error: enum 'Response' cannot be Copyable — case '.err(Error)' owns heap
  memory; mark it `owning enum Response`
```

### B2. `Box<T>` covers cycles _and_ identity

Adopt v1 §3 / v2 B2 with D2's spelling. Boxing is required — and prescribed in
the error — when a struct would contain itself, and when a value needs a
stable address that outlives a move (handed to FFI with an untracked lifetime,
captured by a worker, shared across a boundary the borrow checker cannot
span). One type, two documented reasons; nothing boxes silently.

### B3. Parameter modes: describe, don't change

v2 C1 showed the mechanism is already right. Document only: bare `T x` is
read-only, `ref T x` is a spelled mutable borrow, `move T x` transfers —
uniformly for every type.

### B4. Trait objects (the gate for class removal)

Dynamic dispatch needs a stable pointer. Today value-struct conformers work
only in trait-typed locals (tier 1, `src/check/utils/trait_slot.ts`); every
call/container boundary requires a `class`. Removing `class` removes that
stable slot, so Phase B must specify:

- A trait-typed binding/param/field is a **boxed handle**: `(vtable,
instance)`.
- Assigning a concrete struct to a trait-typed slot **boxes** it — the trait
  annotation is the marker. Boxing a local is a move; boxing a fresh temporary
  is free.
- The tier-1 inline-local optimization may survive as an optimization but must
  no longer be load-bearing for correctness, in **both** backends.

Decided (T1–T4):

**T1. Boxing is implicit; the annotation is the marker; no `box` keyword.**
The `Box` precedent applies: `var Box<Node> n = …` puts the representation in
the type and nobody wants a keyword there; `var Drawable d = …` is the same
statement. The annotation _specifies_ the representation (trait slot = boxed
handle), so the allocation is predictable from the text — the marker
principle is satisfied by the type, not the verb.

**T2. Boxing takes ownership.** The handle owns the instance:

```nomen
var Drawable d = xs          // boxes xs — xs is MOVED, invalid after
var Drawable e = List<int>() // fresh temporary: free
var Drawable f = xs.copy()   // explicit deep copy, xs alive
```

This settles the `ref`/`view` interaction: **borrows and views cannot be
boxed.** Boxing a `ref` source would require copying an owning type (only
`.copy()` does that, spelled), and a view is region-bound and cannot be
owned — `error: boxing owns its instance — move the value, or copy it
('.copy()')`. Mutation through a handle requires `ref` spelling
(`func f = (ref Drawable d)` + `f(ref d)`); the existing const/update
machinery covers it verbatim — a trait handle is just an owning struct whose
methods dispatch. No new rules.

**T3. No heap at borrow boundaries — tier-1 reborn as a calling
convention.** A bare trait param is read-only (B3), and a read-only borrow
cannot be kept by the callee — so passing a concrete value to a bare
`Drawable` param may pass `(static vtable, pointer-to-stack-copy)`: zero
malloc, the box lives on the caller's stack for the call. Heap boxes happen
only at annotated storage sites — locals, fields, containers, returns —
where the annotation is visible in the text. This is today's tier-1 inline
conformer, made sound-by-construction instead of position-limited.

**T4. Tier-1 demotion = checker deletion.** The tier-1/tier-2 distinction
(`value_struct_trait_error`, the `trait_slot.ts` tiers) stops being a
correctness mechanism: both backends emit handles at every trait position,
destroy dispatch rides the existing vtable-destructor path, and during the
transition era a class conformer boxes by pointer (no malloc — the instance
is already heap) until R unifies it.

Until this is implemented, do not remove `class` for any type used as a
trait object.

### B5. Collapse the field restrictions; field spelling follows the type

With `owning struct` present, "struct fields cannot be class/trait types"
(`check_struct_node.ts:157-171`) becomes "an owning-typed field forces
`owning`" — a predicate verification error naming the fix. Do this after B4
fixes the trait representation.

**No `move T` field spelling — `var` stays; ownership follows the field's
type.** v2's fields row (`move T`, "owning field") was decorative: "stores
must transfer" is fully implied by the field's type being owning. `var
List<Log> h` says everything — `var` = mutable slot, `List` = move-only type
⇒ transfer-on-store, no copy-out, swap extraction. A `move T` spelling would
have to mean "force transfer on a Copyable-typed field," which is
meaningless. Field behavior:

| Field               | Behavior                                        |
| ------------------- | ----------------------------------------------- |
| `var` + owning type | transfer-on-store, no copy-out, swap extraction |
| `var` + Copyable    | copy stores                                     |
| `view T`            | non-owning, region-bound (§N4)                  |

**Migration churn for field spellings: zero.**

### B6. Nullable owning structs: one mechanism, two lowerings

Decided: keep both representations. The checker's optional machinery (`nil`,
`== nil`, unwrap, `switch`) stays representation-agnostic; the backend picks
the lowering mechanically by shape — no struct-introspection cleverness:

| Optional                                      | Lowering                                       |
| --------------------------------------------- | ---------------------------------------------- |
| `Box<T>?`, trait-handle `?`, `WeakHandle<T>?` | null pointer/handle — the natural null slot    |
| inline struct `T?` (owning or Copyable)       | companion flag (shipped, `nullable_struct.ts`) |

Unifying on `Box` — desugaring `T?` for an owning struct to `Box<T>?` — was
rejected: it would malloc every optional `List<int>?` local and field, the
accidental-boxing trap v1's performance section forbids. Unifying on the
flag was rejected: it wastes a presence byte on types with a natural null
slot and breaks the null-pointer optimization (D2). Two lowerings, one
language-level semantic; both are specified by the type spelling. At R,
class optionals migrate mechanically onto the companion flag as the class
nil-pointer form retires with `class`; `WeakHandle<T>.get() -> T?` rides the
standard machinery.

---

## Retiring `class`

**There is no semantics-preserving alias** — `class Window w1; var Window w2
= w1` aliases today; `owning struct` makes that a compile error at every use
site. Decided: **deprecation warning at B4, removal at R, no post-R alias.**
A deprecated alias that still works would keep two object models alive
through the checker and both backends past the transition era, for zero
behavioral kindness — the rewrite is an error either way. The B4 transition
already coexists with classes (class conformers box by pointer), so a
deprecation _warning_ there is free and prepares users; R removes the
keyword and rewrites `core/` in the same effort. The R error names the fix:

```
error: 'class' has retired — declare `owning struct Window` (single-owner,
  move-only) and spell sharing where it happens (`ref`, `Mutex<T>`,
  `WeakHandle<T>`)
```

**The audit maps onto the shape menu.** Every cross-class reference in
`core/` becomes one of:

| Shape                            | Spelling                           |
| -------------------------------- | ---------------------------------- |
| owned child (tree)               | `var T child` on `owning struct`   |
| owned subtree, variable/nullable | `var Box<T>? child`                |
| back-pointer (child→parent)      | `var WeakHandle<T> parent`         |
| OS-retained / delegate           | `var WeakHandle<T>` + registration |
| shared within a lexical scope    | `ref` binding (Phase A semantics)  |
| shared across tasks              | nursery region borrow / `Channel`  |

Per type: `Thread`/`Fiber`/`Task` → owning struct + handle fields, with
`#spawn` extended to work on **owning structs** (it is class-keyed today —
the construction hook must survive R); `Mutex` → the §N4 shape (`Handle` +
`Shared<T>`); `Channel` → handle-backed owning struct (moves freely);
`Window`/Controls → handle + `WeakHandle` delegates + documented
main-thread affinity. `Spawnable`/`Awaitable` are traits — unchanged.

**Sequencing.** Nurseries, cancellation, and the task runtime are already
shipped (`docs/ASYNC.md`) — nothing is blocked on them. `core/System` cannot
leave classes until the checked-borrow sharing story (§N1/§N4) lands and B4
boxes trait objects. Order: **A → N → B4 → R**.

---

## Remaining work (all open questions resolved)

Every design question in this plan is decided. What remains is
implementation, in dependency order:

**Checker (both backends share it)**

1. Phase A: `ref` bindings — parse, the A1 trigger rule, A3 mutation rules,
   error tests.
2. Phase N: R2 region checks + R3 freeze at the `#spawn` construction;
   the E3 call-form root check and R4 daemon rule **land early** (they fix
   live dangles).
3. B1/B1a: declared ownership + the Copyable predicate verifier (structs and
   enums); migrate built-ins.
4. B4: handle-everywhere trait positions; delete the tier-1/tier-2 checker
   distinction (`value_struct_trait_error`).
5. R: remove `class`; `#spawn` on owning structs.

**Backends (C and aarch64)**

1. `Box<T>` magic: constructor, destroy (destroy-pointee + free),
   transparent field/method access — the `List`/`Buffer` special-case tier.
2. Trait-handle calling convention (T3: stack-copy boxes at bare-param
   boundaries) + vtable destroy dispatch.
3. `WeakHandle<T>`: the global id+generation registry, opt-in `.weak()`
   registration, `#destroy` generation bump, `.get()` — content-keyed
   runtime emission (the async-runtime pattern).
4. `Atomic<T>` and `Shared<T>` protected slots.
5. Env packing for borrowed owning arguments (§N1a — reuse the class-arg
   path, minus the destroy).
6. R: per-type rewrites of `core/` per the shape menu.

Already shipped and untouched: the task runtime — pool, futures, fibers,
nurseries, cancellation, deadlock detection (`docs/ASYNC.md`).

## Migration sketch

| Today                                           | Phase | Under the plan                                 |
| ----------------------------------------------- | ----- | ---------------------------------------------- |
| `var Box q = p` (silent alias)                  | A     | `ref Box q = p` (error without it)             |
| `class Node { var Node? next }`                 | B     | `owning struct Node { var Box<Node>? next }`   |
| `struct Config { var List<Log> h }` (error)     | B     | `owning struct Config`                         |
| `struct P { var string s }; var q = p` (error)  | B     | still an error → `owning struct P`, or `view`  |
| `Array<Control>` / `ClassBuffer<Control>` slots | B     | boxed trait handles (B4)                       |
| `class Window` / `Mutex` / `Channel`            | R     | `owning struct` + handle field                 |
| cross-class references                          | R     | object-graph menu (§Retiring `class`)          |
| detached-style concurrency                      | N     | `.detach()` owns its captures (move/copy only) |
| OS-retained delegates                           | N     | `WeakHandle<T>`                                |
| `move` / `ref` / `view` / `for ref` at bindings | A/B   | unchanged                                      |

Docs: consolidate the struct/class sections of `SPEC.md`, `docs/MEMORY.md`,
and `NOMEN_AGENTS.md` into one.

## Alternatives considered

- **v1 as written.** Rejected in v2: ships the risky work first, misstates
  migration cost, no trait/concurrency answer.
- **v2's Phase C (`shared struct` + refcounts).** Rejected here: hidden
  runtime aliasing contradicts the marker principle; refcounts leak cycles and
  cost atomics on every binding copy; and nurseries recover the same
  expressiveness statically. `shared struct Mutex` ≈ `Arc<Mutex<T>>` is
  strictly more machinery than owner-outside + borrows-in + join-at-barrier.
- **A `weak` keyword.** Rejected: the library type fits the handle vocabulary,
  its creation is the marker, and it costs no keyword surface or checker
  changes. A keyword cannot buy a static guarantee here — the race is
  inherently dynamic.
- **A `Shareable` trait or `shareable` modifier.** Rejected in favor of
  field-level protected slots (`Atomic<T>` / `Shared<T>` / handles) with
  derived shareability. The trait is a category mismatch — Nomen traits are
  dispatch contracts and `Shareable` would never be a value type. The
  modifier compiles mis-paired guards (`shareable struct Session { var Mutex
m; var List<Msg> log }` — does `m` guard `log`? the checker cannot say).
  Field slots make guard pairing expressible, keep the declaration ladder at
  two rungs, and move the error to the share site where it names the
  unprotected field. Inferred _permission_ is safe where inferred _copy
  semantics_ was not: granting permission changes no existing use site.
- **A `Sendable` marker (Rust-style).** Rejected: it guards against refcounts,
  escapable guards, and open-world conformer sharing — none of which exist in
  this design. A marker would be ceremony verifying nothing. The
  param-vocabulary boundary rule covers every crossing, and region-bound
  types close the only smuggling route (`view`-bearing structs).
- **Only Phase A, stop there.** Legitimate; B/N/R are genuine improvements but
  deferrable.
- **Fully inferred semantics / heap-everything + GC.** Rejected, for v1's
  reasons.
