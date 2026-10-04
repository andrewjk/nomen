# PROGRESS — STRUCT_PLAN_3 Phase N (tranches 1–2: checked region borrows)

Status snapshot for Phase N. Tranche 1 landed the early dangle fixes (the E3
call-form root check and the R4/N2 detach rule); tranche 2 completed N1a —
the full R1 capture classification and the R3 freeze. Remaining: N3
(WeakHandle), N4 (protected slots).

## What is implemented

**N1a R2 / N1b E3 — the root rule at the spawn boundary**

Inside an `async { }` block, a SHARED class/trait spawn argument's ROOT must
outlive the join:

- the root must be declared in the async block's own scope or outside it —
  never in a nested block (an `if` body, a loop iteration whose scope ends
  first). Params and globals always pass.
- a FRESH class temporary (a call/constructor result) — or a checker-hoisted
  `_param_N` temp, which has no StackValue yet at validation time — is
  anchored at the CONSTRUCTION's scope, so the construction itself must sit
  in the block's own scope.
- moved and copied arguments are exempt (ownership has no region); scalars,
  strings, and owning value structs are copied at the boundary and exempt.
- a non-Sendable class still reports the SENDABLE error (the region rule
  only runs for arguments that passed every other gate).

Enforcement lives in `src/check/utils/spawn_region.ts`
(`enforce_spawn_arg_region`), called from
`validate_spawn_args_sendable` (the existing Sendable validation site, per
E3). Plumbing: `CheckStatus.nursery_scope_depths` (the body scope depth of
each enclosing async block, pushed by `check_async_block_node`) — and
`clone_status` now carries `nursery_depth`/`nursery_scope_depths` (they were
NOT in its field list before, so `nursery_depth` never survived a nested
block clone — effectively dead state; the clone fix is load-bearing).

Error texts (from the plan's N1a):

- `'m' does not outlive the task — the join at 'async' happens after 'm''s
scope ends; declare 'm' in the 'async' block's scope or outside it, or move
it in ('move m')`
- `this task shares a temporary Job that dies before the 'async' join — bind
it to a local in the 'async' block's scope and pass the local`

**N2 / R4 — detach owns its captures**

`.detach()` has no join anywhere: a daemon outlives every scope, so a shared
class/trait argument has nothing bounding it. `enforce_detach_owns_captures`
(same util, called from `check_access_node` at the `.detach()` boundary)
rejects every non-`move` class/trait argument of the CHAINED construction
`Thread(fn(x)).detach()` / `Fiber(fn(x)).detach()` — Sendable or not — and
rejects class/trait CAPTURES on the closure form (`Thread(() => f(x)).detach()`;
captures cannot be move-spelled). Globals are exempt (process lifetime — the
plan's "app-lifetime channel" shape).

Error text: `detached task captures 'g' by reference — detach owns its
captures; move it in ('move g'), or spawn it into a nursery that outlives
the use`.

Known gap (recorded, deliberate): a construction stored in a variable and
detached later (`var t = Thread(f(x)) ... t.detach()`) is not flow-tracked;
the chained form is the enforced (and documented daemon) spelling.

**N1a R1 (tranche 2) — the full capture classification**

Argument classes at the task boundary (checker: `spawn_arg_region_class`,
`enforce_spawn_arg_region`; build: both packers share the matrix):

- OWNING value struct, bare, INSIDE an `async` block → a region-checked
  BORROW: the env stores the donor's pointer (no deep copy), the root rule
  bounds the donor's scope, and the freeze (below) keeps it const. Stamped
  `region_borrowed_args` on the deferred call; monomorphized-body clones
  never re-validate and keep the copy packing (safe fallback).
- OWNING value struct, bare, OUTSIDE a nursery → compile ERROR: no join to
  bound a borrow, and the old env deep-copy was unsound for owning structs
  (only string fields were duplicated — a container field shared its buffer
  and the env destructor freed the donor's live buffer). `move` params still
  transfer.
- `view`-typed args → a borrow of the source: region-checked + frozen inside
  a nursery; the env pair is stored as-is.
- Class/trait args stay shared pointers (`Sendable` gate, transition era).
- Scalars/strings/plain-data structs: copied (strings duplicated at pack).

C backend: `OwnedArg.kind "borrowed"` — env field is the donor pointer, the
destructor skips it, the pack is `&(donor)` (valid C per the value emitter's
`&*x` contract). aarch64: value-struct args stage the donor's ADDRESS
(`emit_struct_address_param` — a plain value read yields the first word),
classes/traits stage the instance pointer, and the helper copies/borrows per
class. Env field types are the MONO names (`struct List_int *`) on both
backends — the generic template name made `struct List` an incomplete type
and conflicted with the callee's real mono signature.

**N1a R3 (tranche 2) — the freeze**

A borrowed root is const from the construction until the `async` block
exits. `CheckStatus.nursery_frozen_roots` is one Set per enclosing async
block; block clones share the innermost set BY REFERENCE (the freeze outlives
the construction's branch) and the frame dies with the block's cloned
status. Gated at every mutation path: assignments through the LHS root
(`check_assignment_node`), move-out declarations/assignments, mutable-passing
(`move x` params), mutation through a `ref` alias of a frozen source (§A3.1
arm), and `ref self` method calls on the root or a field path
(`check_access_node`). Error: `'xs' is borrowed by a task until this 'async'
block exits — it is read-only here (move a copy in, or move it in at the
spawn)`.

Exemption: `Task`-typed roots are NOT frozen — sharing a task's handle and
then cancelling it is the coordination protocol (`t.cancel()` after a spawn
is the sanctioned shape).

**BUGS.md #7 (tranche 2) — spawning with value-struct args never compiled**

`Thread(work(some_struct))` was broken on both backends on `main`: aarch64's
companion used by-value typedef names against one-word staging (never
compiled), and C used the generic template name (`struct List *` — an
incomplete type conflicting with the callee's mono signature); where the
types existed, the env deep-copy was shallow (container fields shared their
buffer → stale-free at teardown). Fixed by the shared R1 matrix above.

**BUGS.md #5 (tranche 1) — root-scope class globals (both backends, pre-existing)**

The daemon migration (global app-lifetime channel) exposed that a
root-scope CLASS variable was compiled as a main-local on BOTH backends —
unreadable from any other function (`Undefined symbols: g` on aarch64;
`use of undeclared identifier 'g'` on C). This mechanism is almost
certainly the original FOLLOWUP repro #3 ("root-scope ref — Undefined
symbols: q"). Fixed: module-scope data storage (aarch64: `.data`-section
symbol via an `is_module_init` stamp; C: file-scope definition in the
header preamble + prologue assignment). See BUGS.md #5 for the full
writeup; value-struct/trait-typed globals have the same shaped gap and were
left (no current shape needs them — noted in BUGS.md).

**BUGS.md #6 — `test_error` helper infinite loop (pre-existing)**

The comma-operator loop condition spun the vitest worker forever on an
out-of-range line expectation. Hardened.

## Tests

- `test/spawn_region.test.ts` — 16 checker tests: the root rule (loop-local
  donor, block-scope donor, outside-async donor, fresh temp in/out of the
  block's scope, moved/scalar exemptions, Sendable-vs-region error priority,
  outside-async unchecked) and the detach rule (shared/moved/global,
  scalars, closure-form capture, Fiber parity, empty daemon).
- `test/daemon.test.ts` — migrated to the app-lifetime channel shape
  (root-scope global, params renamed to avoid shadowing); the Sendable test
  now also asserts the detach error.
- `test/spec/concurrency.test.ts` — the SPEC daemon example respelled to the
  global channel; a new detach-rejection test. `SPEC.md` documents both
  rules (spawn section: the two lifetime rules); `docs/ASYNC.md`'s "Daemon
  tasks" section rewritten (move-only rule, global exemption, the
  stored-construction gap).

## Verified

- All repro probes (n2–n9, g1–g4) behave on both backends via the CLI.
- Full suite green (3955 tests) before the test-file additions;
  spawn_region + daemon + spec files green after.

**N3 (tranche 3) — `WeakHandle<T>`**

A checked handle to a possibly-gone object: one process-wide (pointer,
generation) slot table with a free list, mutex-guarded (WEAK_HEADER, both
backends). `WeakHandle<T>(obj)` registers the instance — the construction is
keyed on the `#weak` MEMBER (the library-tier marker rule, beside `#init`/
`#destroy`/`#spawn`; parse_statement + parse_visibility gained the `#weak`
arm). Checker: `check_weak_ctor` — T must be a CLASS, the object must be
owned ELSEWHERE (a fresh temporary has no owner and is rejected), exactly one
argument, an explicit type argument must match. The handle owns nothing and
BINDS ONCE at its declaration — the assignment form is rejected ("a handle is
not re-pointed", the §A3.2 discipline). The tracked type's `#destroy`
(user + auto, both backends) calls `__nomen_weak_invalidate(self)` first —
generation bump, so a recycled slot never aliases a stale handle. `get()`
raw bodies (C + aarch64) compare generations and return the live pointer or
NULL; bind to `T?` and nil-check.

Runtime plumbing: WEAK_DECLARATIONS (system.h: typedef + allocator macros +
prototypes — globalize_runtime drops typedefs/defines, so they ride the
declaration text), ensure_weak_runtime (C: "all" emits the header; "system"
defines with external linkage via c_runtime_defs; "user" references
system.o) and ensure_weak_runtime_a64 (the user companion always carries its
copy; the system object skips — same pattern as the pool). The registry's
own tables allocate through WEAK_REALLOC/WEAK_FREE aliases so audit builds
do not count process infrastructure, and an atexit teardown frees them.

Known shape: the aarch64 free-timing is eager, C defers a displaced class
instance's free past live borrows — an invalidation test asserts each
backend's truthful reading (the divergence is pre-existing and documented).

## Not yet done (Phase N tranche 4)

- **N4 — protected slots** (`Atomic<T>`, `Shared<T>`, the `with(m)` critical
  section form, shareability derivation). The freeze's `with(m)` exemption
  hooks into this.
- **R1 completion note**: the A1-style at-vs-pop classification for
  container-element spawn args (`list.at(i)` as a donor) — the root rule
  currently keys on the base variable, which bounds container elements
  correctly via the container's scope; the at-vs-pop transfer distinction
  lands with R1's container work if ever needed.
- **E2** capture kinds + **the string-captures-move flip** — deferred to R
  (they ride D3).
- R1 completion note: the A1-style at-vs-pop classification for
  container-element spawn args lands with R1.
