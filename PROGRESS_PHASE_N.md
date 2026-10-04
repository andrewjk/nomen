# PROGRESS — STRUCT_PLAN_3 Phase N (tranche 1: the dangle fixes)

Status snapshot for Phase N tranche 1. Per the plan's sequencing, the E3
call-form root check and the R4/N2 detach rule "land early — they fix live
dangles"; the fuller R1–R3 region machinery, WeakHandle (N3), and the
protected slots (N4) remain.

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

**BUGS.md #5 — root-scope class globals (both backends, pre-existing)**

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

## Not yet done (Phase N tranches 2+)

- **R1's full capture-classification table** at the `#spawn` construction
  (owning-type bare args → const borrow + region check; `view`-typed args).
  Today's tranche covers the shared-pointer case only.
- **R3 — the freeze**: borrowed roots const from construction until the
  async block exits (checker-side borrow_depth at region scale).
- **N3 — `WeakHandle<T>`** (registry, `.weak()`, `.get()`).
- **N4 — protected slots** (`Atomic<T>`, `Shared<T>`, the `with(m)` critical
  section form, shareability derivation).
- **E2** capture kinds + **the string-captures-move flip** — deferred to R
  (they ride D3).
- R1 completion note: the A1-style at-vs-pop classification for
  container-element spawn args lands with R1.
