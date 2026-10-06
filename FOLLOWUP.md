# Follow-ups

Skipped or out-of-scope items recorded for later.

## Bare nested blocks are not statement syntax (feature gap)

Found 2026-10-06 while writing `test/spawn_ctor_struct.test.ts` (Phase R
tranche 1): a bare `{ … }` block statement inside a function body is not
supported — the parser produces a value node for `{`, so the check fails
with `Unknown value: {` (and everything after it cascades: the block's
statements fall out of scope, so `Console` itself reports "Unknown value").
A control program with the same shape minus the struct plumbing reproduces
it on `main`; nested blocks under a construct (`if`/`while`/`async` bodies)
are fine.

Why it's worth building rather than leaving: deterministic destruction is
the language's core model, and a bare block is the one-zero-cost way to
release an owning value before the enclosing function ends (my test wanted
exactly that — scoping an unstarted spawn construction so its `#destroy`
could reclaim the task machinery mid-function). The current workaround,
`if true { … }`, is semantically a lie and reads like one. C/C++/Rust all
have the bare form; Swift calls it `do`.

Implementation surface: a `{` case in `parse_statement` (or the block
statement reader) that parses a nested statement list into the existing
block node; the checker needs only a passthrough (it already handles block
nodes under every construct); both backends lower nested blocks for
if/loop bodies already, so a bare block should ride the same path — verify
scope-exit destroys fire at the block's end on both backends.

## STRUCT_PLAN_3 Phase R — retire `class` (in progress)

Sequenced after A → N → B4 (all landed). The B4-era deprecation warning was
deliberately skipped (decision 2026-10-06: go straight at the substance).

- **Tranche 1 (landed): `#spawn` on owning structs.** The construction hook
  survives the value tier — an `owning struct` declaring `#spawn` constructs
  through the same special form as a class. The C statement expression now
  yields the inline instance (the declaration side always typed the
  initializer as the struct itself); the aarch64 companion helper writes the
  instance through an sret parameter (x0, the WeakHandle convention), with
  the packed args shifted to x1+ (seven register slots, overflow unchanged)
  and expression contexts materializing a fresh temp whose address the
  value-struct convention leaves in x0. `spawn_instance_info` gained
  `is_class`; the Awaitable `_vt` install is class-only (a value struct has
  no embedded vtable — trait dispatch rides boxed handles). Thread/Fiber
  (class) emission is byte-identical; covered by
  `test/spawn_ctor_struct.test.ts` on both backends (both construction
  forms, generic mono, string result, unstarted-construction `#destroy`
  reclaim, fresh-construction-as-receiver/arg).
- **Tranche 2 (landed): `Thread`/`Fiber`/`Task` → owning struct + handle
  fields** (the shape menu). The three types were already handle-shaped
  (uint64/bool fields), so the conversion is mostly the declaration: `pub
owning struct Thread<T> : Spawnable<T>` / `Fiber<T> : Spawnable<T>` /
  `Task<T> : Awaitable` — `Sendable` dropped (structs auto-derive; the
  fields are all scalars). Both layouts already reserve the `_vt` word at
  offset 0 for every struct, so the raw asm bodies' field offsets are
  unchanged. What moved with them:
  - `build_nursery_spawn` (both backends) reworked for inline instances:
    the C statement expression copies the Thread value, transfers the
    handles, and yields an inline Task (no heap instance, no `_vt`, no temp
    free); the aarch64 companion helper takes the Thread by address and
    writes the Task through a leading sret parameter (x0), leaving the
    buffer address in x0 (the value-struct convention).
  - The aarch64 fn-value construction now stages nursery-capture frame
    addresses in x2–x4 when sret is in effect (tranche 1's "captures never
    co-occur with sret" held only while Thread/Fiber were classes).
  - Checker: the owning-struct receiver hoist
    (`check_access_node`) hid the `Thread(...)` ctor from the detach
    capture rule — the rule moved above the hoists; the discarded-result
    hoist (`check_block_node`) extends to owning structs whose ownership a
    scope-exit destroy reclaims (a discarded `Thread(...).start()` Task
    leaked its future reference); struct reassignment of an OWNED method
    return (`t = t2.start()`) keeps the variable registered (the C
    assignment path classified every method result as an aliasing borrow —
    a `move out T` return is a fresh value); the moved-trait-arg boxing at
    a call site resolves the MONO struct name (`Task` + type args →
    `Task_uint64`, so the box is actually built instead of aliasing the
    donor).
  - `Awaitable.wait` takes the receiver by VALUE (`func wait = (self)`) —
    waiting parks on the future the handle names and never mutates the
    handle, so the bare `Awaitable` parameter (T3 stack-copy box, caller
    keeps ownership) is the sanctioned dispatch form; `wait`'s legacy
    `pthread_join` fallback (dead since the pool migration — `handle` was
    permanently zero) is gone. `Thread`/`Fiber`/`Task` doc comments and
    SPEC/ASYNC.md updated.
  - Test-infra note resolved: the system objects rebuild automatically —
    the stale check hashes the GENERATED output, so the core edits
    invalidate it. One real gap surfaced: `lib.ts`'s type-name extractor
    didn't recognize `pub owning struct` (the first owning structs in the
    library), so the affected files silently dropped out of the joined
    source — fixed with an `(?:owning )?` in the regex.
  - Covered by the existing concurrency corpus (task/thread_struct/
    fiber/fiber_phase2/daemon/awaitable/spawn_region/... all green on both
    backends); `test/awaitable.test.ts` retyped to the bare-trait-param
    dispatch form, and the fiber park/cancel shapes use `move` /
    `ref Task` spellings where the class era relied on aliasing.
- **Tranche 3 (landed): `Channel`/`Mutex`/`Tcp`/`Tester`/`Random` → owning
  struct.** All five are `pub owning struct` (the shape menu); `Sendable`
  dropped — structs auto-derive (all fields are handles/scalars, except
  Tester's two string fields, which the struct string machinery
  normalizes). What moved with them:
  - `#init` raw bodies in Mutex/Channel use the `self.field` spelling (the
    C ctor's `self` is the INLINE instance — a local value; methods keep the
    pointer form). The aarch64 bodies are unchanged (x19 = &instance).
  - Split-build WeakHandle fix: the user TU previously relied on the system
    TU's class destroys pulling the registry declaration into system.h —
    with no classes left in the System library, a user class's `#destroy`
    failed to compile (and link). `build_split` now threads
    `system_defines_weak_runtime` from the system build; the user TU defines
    the registry itself when the system object doesn't.
  - Root-scope owning-struct globals: file-scope storage in both backends
    (the BUGS.md #5 shape — see the section above).
  - Spawn-arg validator: a PROCESS-LIFETIME GLOBAL donor of an owning type
    is exempt from the outside-a-nursery error (process lifetime is its own
    region proof — the same exemption the detach rule takes); the env packs
    the pointer (a borrow, no copy, no destroy).
  - Corpus migration: spawns sharing a Channel/Mutex moved into `async { }`
    blocks (the join bounds the borrow; send/receive/lock/unlock take the
    receiver bare = const, so the freeze doesn't block them); daemon
    handshakes moved the shared channel to a global; the Tcp listener
    helpers take `ref Tcp` (a mutable region borrow, `ref` spelled at the
    call site). SPEC.md's yield/is_fiber example updated with its
    `test/spec/concurrency` twin.
  - Known pre-existing fallout surfaced while testing: the aarch64
    tcp_scale hang above (repros on main).
- **Tranche 4: remove the keyword.** Parse/check/both backends; migrate the
  ~900 class uses across the test corpus to `owning struct` + `ref`/`Box`/
  `WeakHandle` shapes (done — zero `class` uses remain in `test/`);
  `ClassBuffer` retires to its trait-handle remainder. Progress: **`Box` now
  DECLARES as `owning struct`** (representation unchanged — the checker
  stamps the wrapper's storage class at gather time,
  `stamp_box_wrapper_representation`; `monomorphize` propagates `is_owning`
  into monos), and **all seven `Controls` classes are now `owning struct`**
  (Window/Container/Button/TextBox/Text/CheckBox — `pub owning struct X :
Control`, the shape menu's handle form; the raw `#init` bodies use the
  `.handle` value form in `#arch: c` blocks and the `->handle` pointer form
  in `#arch: aarch64_use_c` blocks; `Container`'s resize delegate takes the
  owning-struct `ref` lowering, `struct Container *`, with the documented
  app-lifetime address-stability contract). **`core/` has zero `class`
  declarations.** En-route backend fixes, both required by the first
  struct-with-a-`use_c` constructor (no owning struct had one before):
  - the aarch64 companion ctor for a struct is now void-and-mutate-self
    under the BARE label (the class-ctor convention) instead of emitting a
    by-value return + x8 thunk that struct ctors (x0 = &instance) never
    stage (`generate_c_function`, `build_raw_node.ts`);
  - the companion ctor installs `_vt` (extern-C alias of the `.globl`
    `_<Struct>_traits` table) and seeds LITERAL field defaults (string
    statics, scalar/bool) — the asm ctor's jobs; non-literal defaults in a
    `use_c` ctor are a build error naming the field.
    Remaining before the keyword removal: SPEC.md/README.md/GUI.md rewrites
    (`class` → the owning-struct vocabulary, ~31 SPEC mentions), then the
    parse/check/backend keyword sweep.
    B1 full cutover (the Copyable verifier over inferred ownership) follows,
    per its own sequencing note in the Phase B section below.

## STRUCT_PLAN_3 Phase B — remaining tranches

Tranches landed: 1 (declared ownership: `owning struct`/`owning enum`
spellings, the flag-wins semantics, the declared-subset Copyable verifier),
2 (`Box<T>` — remaining aarch64 gap: a generic CLASS with an inline
value-struct `T` field sizes `T` as one word, BUGS.md #10), 3 (B4 —
trait objects: boxed handles at every trait position on both backends,
tier-1 demotion, boxing takes ownership, the T3 stack-copy convention at
bare `Trait` params), and 4 (B5/B6 — the field-restriction collapse: a
class-typed field on a bare `struct` is the Copyable-verifier error, an
`owning struct`'s class fields are owned slots (`var` spelling, move
auto-init params, displaced-store reclaim, destroy on both backends);
nullable lowerings pinned: `Box<T>?`/trait-handle `?` = null pointer,
inline structs keep the companion flag, nullable owning-struct RETURNS
normalize their string fields on both backends). The rest of Phase B:

- **B1 full cutover**: the Copyable verifier over INFERRED ownership (a bare
  struct with a string field → error), migrating every existing owning
  struct to the declared spelling. Sequenced after the built-in rewrite
  (post-B4/R) — the string-only-struct borrow-copy semantics are
  load-bearing in the memory model until then.
- **Trait-typed FIELDS on owning structs** (the B5 remainder): rejected
  with a named fix ("declare it with the concrete type, or
  `Box<Concrete>`") until the boxed-handle field lowering exists — field
  storage as a `void*`-shaped handle plus vtable dispatch THROUGH a field
  (both backends; the aarch64 field-shaped dispatch path still carries the
  pre-B4 inline shape and the C field member type needs `void *`). Not in
  the R shape menu (fields hold concrete types / `Box` / `WeakHandle`), so
  this may stay rejected permanently if R doesn't need it.
- **R** (after N): retire `class`.

B4 residual corners (deliberate, recorded for later):

- **Root-scope trait consts** (`const Named n = Alice()`) are still
  inlined at use sites via `top_level_consts` — each use re-derives the
  box (and a use as a bare value re-runs the constructor). Fine for
  constants; revisit if root-scope trait bindings need identity.
- **`return <computed concrete>` from a trait-returning function inside a
  switch/match/if join** falls through the generic join path (the box
  branch handles the direct-expression shapes only).
- **User `#destroy` bodies that don't free string fields**: the box keeps
  the raw (rodata) bytes for such structs — the strdup normalization gates
  on "no user `#destroy` && auto-destroy" so the audit stays clean, at the
  cost of those fields never being heap. D3 (string is owning) resolves
  this at B1 cutover.
- The aarch64 `moved_param_is_consumed` trait-receiver resolution scans
  conformers' overrides; a conformer defined AFTER the scan's caller in the
  same build resolves via the whole-program struct table (no ordering
  hazard observed, but worth knowing).

Known pre-existing gap surfaced by tranche 1: BUGS.md #9 (aarch64
enum-with-data value-struct payload crashes at the match binding) — B1a's
owning-enum semantics are proven on C; on aarch64 use a class payload until
#9 is fixed.

## Generic construction without call-site type args links against the generic's init (pre-existing)

Found 2026-10-06 while writing the owning-mono runtime test (Phase R tranche
4): a user generic struct whose only constructor is the auto (bodyless)
field-based `#init`, constructed WITHOUT call-site type args — `var
Holder<int> h = Holder(7)`, T inferred from the annotation — emits a call to
`<Generic>_init` (`Holder_init`), a symbol no backend ever emits (only the
`<Generic_<T>>_init` monos exist). Link fails on BOTH backends (aarch64:
"Undefined symbols … Holder_init, referenced from: main.o"; C: the same
undefined reference in the generated code). Verified on clean `main` at
5e32d3e4 via `git stash` — predates the tranche.

The corpus never hits it: every generic construction either spells the type
args at the call site (`List<int>(…)`, `Holder<int>(7)`) — that branch
renames the call node to the mono name — or has a custom `#init` (the
infer-init-type-args branch renames too). Only the "no call-site args +
bodyless auto-init" shape falls through the final `else` in
`check_function_call_node`'s constructor resolution (~line 222), which finds
no `#init` on the generic, leaves `node.name` as the generic name, and never
renames. Fix surface: that branch (or the declaration-side path that
materializes the mono from the annotation) must point the call at the mono
init the same way the explicit-args branch does.

## Pre-existing gaps surfaced by the B5/B6 tranche (all repro on main)

Recorded 2026-10-06 while writing the tranche tests; each predates this
work and is out of its scope:

- **aarch64: string interpolation is not lowered inside a class `#destroy`
  body** — `Console.write_line("destroy \{self.name}")` emits the raw
  literal `destroy {self.name}` (the interpolation machinery never runs in
  the destroy body build). The C backend lowers the same body correctly.
- **aarch64: string interpolation of a nullable-box member** —
  `Console.write_line("\{b.value}")` where `b` is `Box<T>?` emits the raw
  literal `{b.value}` (B2-era; the C backend lowers it). Works after an
  `!= null` narrowing on some paths; the failing shape is a direct
  nullable-receiver member interpolate. `.to_string()` avoids it.
- **`List<OwningStruct>.at(i)` fails constraint verification** —
  "Parameter constraint cannot be verified: i / i >= 0 && i < self.length"
  (the at-vs-pop classification area A1 called out; owning element types
  trip the constraint check). `pop()` works; this is also the container-
  element trigger A.1 must solve.
- **Nullable bases are not null-tracked** — `opt_field.inner` (and through
  boxes, `box.next.value`) compiles even when the base is nullable; the
  may-be-null check (`Variable 'x' may be null`) fires for plain variables
  only. Flow-sensitive base tracking is a feature of its own; until then,
  bind + `== null`-check before reading through a nullable.

## aarch64: tcp_scale (64 fiber connections) hangs in a parked receive (pre-existing)

Found 2026-10-06 during Phase R tranche 3; **reproduces on clean `main` at
64afe02b** (verified in a separate worktree — same 60 s vitest timeout), so it
predates the tranche. The C backend runs the same program green
(`echoed 64/64`). The hung binary's main thread sits in
`__nomen_fiber_waitq_park` under `Channel.receive`
(`.Lchannel_receive_wait` → `pthread_cond_wait`): main waits for the 64
clients' `done.send(n)` results and at least one wake never arrives — a lost
fiber-wake rendezvous in the many-senders shape (each client fiber sends once
from a pool worker; the send side signals the parked receiver's wait list
under `mu`).

Two operational consequences worth knowing while it reproduces:

- The hung binary outlives the killed test and keeps port 18100 bound, so
  every later tcp_scale run fails fast with `listen failed` until the stray
  `test/out/aarch64/tcp_scale/main.out` is killed (`pkill -f
tcp_scale/main.out`). Kill it before diagnosing anything else in the file.
- `build_and_check_output` runs aarch64 first, so the hang masks the C
  variant's result in the same test invocation; run with the order flipped
  (or the aarch64 artifact removed) to see the C side.

## Root-scope owning-struct globals (Phase R tranche 3 note)

The tranche extended the BUGS.md #5 shape to owning structs: `var Channel
sink = Channel()` at root scope now emits file-scope storage in both
backends (C: `struct Channel sink;` in the header preamble + prologue
assignment + value-destroy teardown; aarch64: an `is_module_init` arm in the
value-struct declaration path emitting writable `.data` storage). Trait-typed
root globals still have the original shaped gap (their BUGS.md #5 pun stands
— no current code shape needs them).

## `Shared<T>` + the `with(m)` critical-section form + typed `Mutex<T>` (N4 remainder)

STRUCT_PLAN_3 Phase N's N4 is otherwise complete (`Atomic<T>`, the
protected-slot freeze derivation, ref-arg spawn borrows); this is the
deliberately deferred remainder, recorded 2026-10-05 in
`PROGRESS_PHASE_N.md`:

- **`Shared<T>`** — the lock-guarded slot type, reachable only through the
  owning lock's critical-section form.
- **`with(m) (T g) { ... }`** — the critical-section form (new syntax:
  parser + checker + both backends).
- **Typed `Mutex<T>`** — the existing hand-locked `Mutex` primitive is
  non-generic; the plan's shape is `Mutex<T> { handle + Shared<T> value }`.

Designed, not built: a checker-level desugar — `m.lock()`; copy-in to the
binding `g`; a synthesized scope-guard whose `#destroy` copies `g` back to
the slot and unlocks, so early returns/breaks release deterministically;
the binding non-escapable (no storing/returning/re-capturing — the rule
family that rejects `ref` fields). Copy-in/out is sound for Copyable `T`;
non-Copyable guard slots are future design. The freeze's protected-slot
exemption hook (check_access_node's `Atomic` arm) is in place for
`Shared<T>` to join.

Until it lands: lock-mediated sharing goes through the existing hand-locked
`Mutex` primitive, and `Atomic<T>` covers the lock-free protected-slot
cases.

## `vp check` lint findings hidden behind the formatting stage (pre-existing)

Found 2026-10-04. On `main`, `vp check` always aborts at the FORMATTING stage
(three files with drifted formatting: `src/build_aarch64/build_function_node.ts`,
`src/build_aarch64/build_struct_node.ts`,
`test/moved_param_string_return_pair.test.ts`), so the lint/type stage never
ran. Once the formatting drift is fixed (as this branch does), the lint stage
surfaces pre-existing findings in files untouched by that work: 4 errors and
16 warnings, unused imports/vars in `test/embed_file.test.ts`,
`test/time.test.ts`, `test/copy_synthesis.test.ts`, `test/flow_bounds.test.ts`,
`test/structs.test.ts`, `test/system_lib.ts`, `test/test_reporter.test.ts`,
`src/test.ts` (no-control-regex), `src/build_aarch64/neon_plan.ts`,
`src/build_aarch64/utils/scan_inline_candidates.ts`. Not fixed there (out of
scope); sweep them whenever `vp check` is next made gating.

## aarch64 class-alias codegen: reads and mutations through an alias crash

**RESOLVED 2026-10-04 (same day).** The three repros below do NOT reproduce —
not on the finished Phase A tree, and not on `main` via any path attempted
(test harness with/without the system-lib split, single-TU builds, CLI `run`,
CLI `test`, the installed nomen). Most likely causes of the original reports:
the session's intermediate checker state (normalizing `ref` → `const` changes
the storage class the alias machinery sees) and repro files sharing /tmp (the
CLI joins sibling `.nm` files, producing unrelated errors). The investigation
did surface three REAL pre-existing bugs, fixed and documented in `BUGS.md`:
prefix-`move` declarations never transferred (checker), the resulting
wrong-message move-through-ref error, and the aarch64 class TRANSFER
double-destroy (`move Box r = move p` ran `#destroy` twice — the likely real
bug behind the SIGBUS reports). Repro (3)'s mechanism was found later during
Phase N: a root-scope CLASS global read from any non-main function failed to
link/compile on both backends — see `BUGS.md` #5. Working shapes to not
regress: local alias read/mutation in a function, root-scope alias with
root/function reads, alias in nested scopes and loops — now covered by
`test/ref_binding.test.ts` on both backends.

Original report (2026-10-04, during STRUCT_PLAN_3 Phase A), kept for context:

Repros (all `aarch64`; each should print a value, instead SIGBUS / link error):

1. **Global alias read inside a function** — SIGBUS.

   ```
   import System
   class Box { var int v }
   var Box p = Box(1)
   var Box q = p
   pub func main = () {
       Console.write("\{q.v}\n")
   }
   ```

2. **Local alias mutation inside a function** — SIGBUS.

   ```
   import System
   class Box { var int v }
   pub func main = () {
       var Box p = Box(1)
       var Box q = p
       q.v = 5
       Console.write("\{q.v} \{p.v}\n")
   }
   ```

3. **Root-scope `ref`** — "Undefined symbols for architecture arm64: q".

   ```
   import System
   class Box { var int v }
   var Box p = Box(1)
   ref Box q = p
   ```

## aarch64 `--release` is a near-no-op by construction (investigated 2026-10-01)

The allmark port measured `nomen test --release` as unchanged on aarch64
(2.2 → 2.3 ms) while C gets 3.5× from clang `-O2`. Verified: the flag DOES
thread through (`build({ optimize })`), and on the 131k-line bench .s the
release pipeline's entire diff is **3,449 lines — every one a
`b .return_X` branch-to-next deletion**. The release-gated pipeline
(`optimize_asm`) is four conservative text passes (constant folding,
unreachable-code, branch-to-next, identity moves); the emitters' one
per-function `b .return_X` before the (always adjacent) return label is the
only shape they ever fire on in this codebase — everything real (frame-slot
forwarding, widen-mask elimination, float forwarding, dead copy-moves,
loop-slot promotion, copy coalescing, if-conversion) runs UNCONDITIONALLY in
every build. Help text now says "aarch64 asm cleanup passes".

Two consequences worth acting on someday:

- **Emitter cleanup**: stop emitting `b .return_X` when the return label
  immediately follows (per-function tail emission). Deletes the branches in
  debug builds too, makes `--release` a true no-op on aarch64, and lets the
  branch-to-next pass converge instantly. Touches every emitter's return
  tail (or a single post-pass in build_function_node).
- **Docs/expectations**: the aarch64 backend has no equivalent of clang's
  heavy lifting (inlining, regalloc, scheduling) — that is the architectural
  posture (the unconditional ASM_PLAN passes ARE the optimizer). Any
  "release mode" expectations for aarch64 should target specific
  optimization tranches (e.g. inline small monomorphized accessors), not
  the flag.

## Trait-declared field ownership corners

The aarch64 layout/size model now includes trait-declared fields
(`layout_fields` in `src/build_aarch64/utils/struct_layout.ts`), and CLASS
destroy reclamation frees trait-declared `string` fields (whose defaults the
ctor strdup's) on both backends — see `test/trait_field_defaults.test.ts`.
Two ownership corners remain, both deliberately left:

- **Value-struct trait `string` fields are borrowed rodata.** The ctor seeds
  a trait string default RAW (no strdup, mirroring the C backend), and the
  destroy excludes value-struct trait fields so it never frees rodata. A
  later heap assignment into such a field is therefore not reclaimed (leak),
  and a later reassignment frees the previous `.ptr` (rodata) — the same
  pre-existing hazard plain value-struct string fields have.
- **Nested trait class-typed fields**: `emit_nested_field_destroys` /
  `emit_destroy_for_array_elem` (aarch64) still walk `struct.fields` only, so
  a trait-declared class field inside a nested/array element is not
  recursively destroyed.

## Custom `#init` computed seeds: residual bounded corners

FIXED (2026-09-30), both backends: the custom-`#init` computed seeds
(`self.a = s + "!"`) the override-displacement analysis used to skip are now
classified by an `#init`-body scan (`init_computed_heap_string_fields`):
qualifying fields are recorded at the ctor-binding sites (scope exit frees the
computed seed — including no-default fields, which cannot be overridden), the
override sites reclaim the displaced computed seed
(`override_displaced_string_fields` / `ctor_heap_displaced_string_fields`),
and the `#init` write itself reclaims a displaced HEAP default (first write;
`claim_init_default_seed_reclaim`). Param-alias seeds (`self.a = s`) stay
un-analyzed (they borrow the caller's argument temp). Covered by
test/override_ctor_displaced.test.ts.

Deliberately left (bounded leak, never an invalid free — same posture as the
method-write record drops):

- A conditional computed write over a RODATA default: the no-write path leaves
  the literal in the field, so the field stays unrecorded and the write path's
  seed leaks (≤1). A heap default closes it (both paths hold heap → recorded).
- Later `#init` writes to the same field displace the previous write's value
  un-freed when it was heap (the init cannot know the displaced value's
  ownership; the first write's default reclaim is the only static fact).

## Nullable-typed bindings now accept may-be-null values (checker relaxation)

`check_return_node` and `check_assignment_node` set `allow_null_value` when the
target/return type is nullable, so `return x` (x a `T?` param) and
`field = nullableParam` no longer error "Variable 'x' may be null". This is
intended (the value's null-ness travels with it), but it is a checker
behavior change: review if any future diagnostic wants to warn on
may-be-null propagation.

## aarch64 post-processing passes dominate large builds (linear but heavy)

Follow-up to the emitter quadratic fix (chunked code buffer +
per-function body buffering): on a synthetic 1609-function corpus (~1.5 MB
asm via the raw API), the build phase is now ~18.8 s of which roughly
15 s is the UNCONDITIONAL asm post-processing pipeline in build.ts
(`optimize_frame_slots`, `coalesce_copies`, … plus `validate_asm` /
`validate_stack_balance`), all linear but with heavy per-line regex work —
CPU profile self-time: `resolve_target` 5.3 s, the
`^([A-Za-z_.$][\w.$]*|\d+):(.*)$` label regex 4.7 s, `strip_comment`
3.2 s. Parse+check is ~1.3 s. The emitter itself is now ~3 s (was ~29 s
quadratic before the fix).

CHEAPENED (2026-10-01) — the three profiled hotspots, byte-identical
outputs (per-pass sha256 over the allmark bench .s, 131,599 lines):

- `resolve_target` linear body rescans → per-function named/numeric label
  maps built once in `check_function_balance` pass 1 (the balance pass now
  strips each body line once and shares the decomposition).
- `validate_asm` ran twice per build: directly, and again inside
  `validate_stack_balance` → `lift_functions`. build.ts now lifts ONCE and
  feeds the structured functions to the balance check
  (`stack_balance_errors_from_lift`).
- `parse_asm_instruction` is memoized by raw text (deep-cloned per call —
  the passes treat parsed instructions as mutable IR, coalesce renames
  operands in place), cutting the regex/tokenizer work in EVERY pass.
  Measured on the bench .s: balance 549→261 ms, promote_loop_slots
  589→375 ms, widen masks 107→64 ms, float forwarding 281→201 ms,
  coalesce 408→323 ms, if-convert 329→243 ms, frame slots 243→209 ms —
  the pipeline drops ~30% with identical outputs.

If large-program aarch64 builds need more headroom, the remaining cost is
each pass's own per-line analysis (no shared line classification between
passes yet — a `label/directive/alias/code` memo keyed on the trimmed line
is the next candidate), plus single-pass line scans where a pass still
sweeps the text more than once.

## aarch64: a lambda capture of a CLASS passes the closure env as the value

Found 2026-10-02 while investigating the cold-run flakiness: an intermittent
`SIGSEGV` in `test/fn_value_spawn.test.ts`'s "a lambda daemon detaches" (the
detached daemon's window makes it look racy) turned out to be a deterministic
codegen bug. The joined form is 100% reproducible, with only the pool worker
involved:

```
import System

func use_channel = (Channel c) {
	c.send(1)
}

pub func main = () {
	var Channel c = Channel()
	var t = Thread(func () { use_channel(c) })
	var h = t.start()
	h.result()
	Console.write_line("joined")     // never printed: exit 139
}
```

The emitted lambda body stores the closure env into the capture's slot instead
of loading the captured pointer out of it (`main.s`):

```
_lambda_0:                       ; capture is a `Channel` (8-byte pointer)
	str x0, [x29, #0]            ; park the env
	str x0, [x29, #16]           ; ← the ENV, not env->c
	bl use_channel
```

A `string` capture of the same shape is correct — it loads both halves
(`ldr x0, [x0, #0]` / `ldr x1, [x9, #8]` then stores them) — so the gap is
the single-word class/pointer capture. The C backend is correct
(`bump(_env->report)`). lldb on the detach variant:

```
frame #0 libsystem_pthread.dylib`pthread_mutex_lock   ; x0 = 0
frame #1 Channel_send + 68                            ; mu = [self+8] == NULL
frame #2 bump + 28
frame #3 _lambda_0 + 24
frame #4 __nomen_spawn_0_trampoline + 80
frame #5 __nomen_detached_run + 68
```

Where to look: the capture's body-side binding. `build_function_node.ts` parks
the hidden env parameter and records `closure_env_offsets` from
`closure_env_layout_a64(node, status)` (offsets keyed by capture name, sized by
`capture_size_a64`), and `stack_var.ts`'s `emit_var_load`/`emit_var_store`/
`emit_var_address` all branch on `closure_env_offsets.has(name)` before the
stack-slot path — so either the offsets map lacks the name at body-build time
(the construction site DOES build an 8-byte env holding the pointer, so
`fn.captures` is populated there) or the capture is bound through a
declaration-shaped path that writes x0 straight into the slot. Note the failing
body has no `closure_env_offsets`-shaped load at all, which is the tell.

Scope note: every existing capture test uses a `string` (or scalar) capture, so
the suite is green — a class-typed capture needs a test of its own once fixed.
Note also that a `class` capture is rejected unless the type is `Sendable`, so
`Channel` is the cheapest carrier.

## Residual ownership-tracking gaps (accepted, narrow)

- **Trait-dispatched value-struct methods bypass the self-write record
  drop**: `scan_self_string_field_writes` resolves the concrete method only
  for direct (non-vtable) calls, so a `self.<string field> = …` inside a
  method reached through a trait-typed receiver can still leave the caller's
  `heap_string_fields` record stale. The record drop also intentionally
  leaks the displaced heap value (dropping without freeing is the only sound
  option when the write is conditional) — see
  `drop_self_written_string_field_records` in
  `src/build_common/scan_self_string_writes.ts`.

  **Failing shape** (aarch64 takes the `trait_target` vtable path in
  `build_access_node`; C dispatches via `_get_trait_func(...)` — neither
  drops the record):

  ```
  trait Resettable { func reset = (ref self) }
  struct Person : Resettable {
    var string name
    func reset = (ref self) { self.name = "X" }   // stores rodata, not heap
  }

  var Person p = Person("Alice")
  p.name = 42.to_string()    // record: "p.name" is heap-owned
  var Resettable r = ... p   // trait-typed receiver
  r.reset()                  // vtable dispatch — record NOT dropped
  // scope exit: stale record frees the literal "X" → invalid free / abort
  ```

  **Fix tiers** (in increasing generality/cost):

  1. _Cheap, partial_: when the receiver is a trait-typed **local**, the
     concrete struct is recoverable from its initializer (the backends
     already do this for destroy dispatch via `resolve_decl_struct` /
     `trait_class_locals`). Resolve it and apply the same scan/drop. Covers
     `var Trait t = Concrete(); t.method()`.
  2. _Conservative, general_: for receivers whose concrete type is genuinely
     unknown (`ref Trait` params, trait-typed collection elements), scan
     **every** conformer's implementation of that trait method and drop the
     union of written string-field records. Sound, but over-drops on
     field-name collisions across conformers (extra leaks, never
     double-frees).
  3. _Systemic_: make value-struct string fields always-heap like class
     fields (strdup on construction/assignment, free on destroy). Deletes
     the entire `heap_string_fields` mechanism and this bug class with it —
     but heap-allocates every literal stored in a value struct and touches
     init/destroy/mov/return paths everywhere. Real perf cost, much bigger
     change.

  **Risk today**: requires all of value struct + plain string field + a heap
  value previously assigned into it + a trait-dispatched method whose
  concrete impl overwrites it with a non-heap value. Classes are immune
  (always-heap fields); core containers don't use this shape (full suite,
  including trait-heavy tests, passes). When it bites, it's the same
  invalid-free abort the direct-call fix addresses, reached via vtable.
  Exposure is strictly no worse than before the fix — the direct-call path
  was the hole that was closed; this is the unfixed remainder.

### ASM gotchas (kept for future work)

- `ldp/stp` simm7-scaled range tops out at **+504** — use the guarded
  helpers (`emit_pair_load_x29` / `emit_pair_store_x29` /
  `emit_string_pair_load/store` in `src/build_aarch64/utils/string_pair.ts`)
  or split ldr/str pairs.
- String-receiver methods: self pair occupies AAPCS slots 0–1 → first real
  param starts at x2 (`start_reg = 2` at call sites; callee prologue
  `slot_idx += 2`). `ref string` self stays ONE slot (&slot) — see
  `self_is_string` gating in build_struct_node.
- Call-site pair detection is by ARGUMENT static type
  (`type_from_value_node(param)?.name === "string"`), NOT callee param
  types — generic signatures (`TK key`) stay generic post-mono.
- `_string_interpolate_N` (aarch64, build.ts): overflow pairs k≥3 read
  from `[x29_helper, #(16 + (k-3)*16)]`.
- Raw `#arch: c` bodies see FAT nomen_string values directly (the thin
  `_raw_`-adapter ABI was removed 2026-09-15) — a C `char*` is an explicit
  `.ptr` (docs/MEMORY.md, "Raw blocks"). T-generic container bodies
  (Buffer_/Array_/…) are natively fat via checker substitution
  (`raw_c_type_name` → nomen_string, `raw_type_size` string→16 — and it
  must mirror struct_layout's ALIGNED sizes).
- String literal lengths come from
  `src/build_common/string_literal_length.ts` (unescape-aware); do NOT use
  sizeof-1 (escapes miscount) or the raw token length.
- Any emitted assembly that must survive a `bl` may only rely on
  callee-saved registers (x19–x28, sp) or stack slots — x0–x18 are
  caller-saved and clobbered by the callee.

## Tranche-3 shelved pieces (measured, not shipped)

ASM_PLAN_5 tranche 3 landed the ext-borrow machinery + hardenings; these
were tried in the same session and reverted:

- **x15 reservation**: withholding x15 function-wide whenever any loop
  holds a pinnable accessor cost +0.02 on pidigits (0.545 vs 0.525
  medians, 6/6 interleaved pairs slower) and LOST the D6 x23/x24 pins
  (the pool shift moved x25 live into D6). Without it a D4 loop borrowed
  x14 (the first ext pin ever fired) but net pins dropped 4→3 and timing
  still trailed baseline. Verdict: pool-shift cost exceeds pin benefit at
  this shape; revisit only with a per-function proven trade.
- **Nested-loop pin refusal**: skipping pins for loops containing nested
  loops (try_count ≤3 receipt: bracket cost > savings). Pin set unchanged
  with/without in pidigits — unmeasured benefit, shelved to keep the
  tranche codegen-neutral.
- **collect_var_refs coverage** (method-arg params under `access_func`,
  if/match/switch branch fields, ref/mov address-taken): real dead code
  (`"access_function_call"` matched nothing; if-branches never walked),
  but broad promotion effects need their own tranche with isolated
  timing receipts. The coupled `_param_N`/`_vn_N` promotion exclusion
  SHIPPED (forwarding elides their declares — garbage-index crash
  guard; neutral).
- **Promotion site-sharing**: sharing loop claims onto decl-site regs
  under the adjacency proof. Reverted to the stage-3 never-touch rule;
  needs an isolated receipt (the D-arm collision it targets carries an
  edge and refuses by construction, but no bench proves the gain).

Full bench matrix byte-identical across backends; pidigits n=4000
0.63 → 0.53 s baseline-relative (the whole ASM_PLAN_5 arc: 1.89× →
**~1.53×** vs C `-O2`); fannkuch-redux −28%; suite green (290 files /
2816 tests) with `test/region_pool.test.ts` + the harness holding the
pass in both arms (it is emission-driven, so the corpus harness runs it
in both — it is not a cursor-dependent transform).

The substrate (plan-side region-free computation, block-membership
liveness, the bracket + pre-seed mechanics) is sound where it fires on
BigInt-shaped methods; the hunt for the remaining invalidation is the
gate for flipping the default.

- **Session-2 forensics note**: the preheader `_vn = wd_off + u_len + 1`
  hoist IS firing in div_to's D4 loops (confirmed in the .s preheader);
  the in-body index chains still read u_len from its slot and rebuild.
  The VN rewrite reaches the NIR spine, but the accessor's index staging
  builds from the AST arg tree — whether the recorded eval+argN splice
  survives to the eval dispatch for THESE statements is the open
  question. A hand-written digit-extraction mini had its own
  loop-terminator bug — rebuild the repro from the test harness
  (check_output's audit path) instead.

## Element iteration for remaining collections (split out of for-of-List)

`for x of some_list` desugars to element iteration for `Array<T>` and now
`List<T>`, but the other collections can't follow yet:

- `Graph<T>` has no `length` at all (the `Enumerable` default returns 0),
  so desugaring via `0..length` would silently produce empty loops.
- `LinkedList<T>`/`Tree<T>` have `length()` methods, but their `.at`
  contracts are phrased against `count` (`idx < self.count`), and a
  `0..length()` range does not discharge that today (verified failing on
  0.2.2) — needs either field-based lengths or return-contract linkage
  from `length()` to the count field.
- `Map`/`Set`/`Buffer` have no `.at(i)` element semantics to desugar to.

Also still open from the same area: `for ref x of list` is rejected with
a dedicated error (List `set` takes `move T`, so the array writeback
shape doesn't transfer — needs its own design).

## CLI: `nomen test` build phase runs out of memory (OOM) on the allmark project

`nomen check --in test/<file>.test.nm` completes in ~6s (12k warnings, 0
errors) on the allmark port, but `nomen test --arch c -f <filter>` — which
parses, checks AND builds the same joined source — dies with
"Ineffective mark-compacts near heap limit" after ~19s and 4 GB (also with
`NODE_OPTIONS=--max-old-space-size=8192`, so it is an allocation loop, not
just a large workload). Even a single-function test file
(`t.expect(true, "tiny")`) OOMs, so the trigger is in the joined src module
or the harness/build path, not in test volume. `nomen run --arch c` on the
same project reaches C emission without OOM (it fails on the
trait_class_locals bug above), so the difference is the test path:
`strip_main_functions` + the generated harness + build. Worth profiling
`run_test_file`'s build phase on this corpus.

## Cross-scope string field stores (dangling + leak halves FIXED; residual conditional stores)

The DANGLING half is fixed. Assigning a heap-owned string local into
a struct field through a `ref` struct parameter used to raw-store the local's
(ptr, len) and then reclaim the buffer at the local's scope exit — the field
dangled the moment the callee returned (C was correct; it strdups). The
aarch64 backend now strdups the pair at the store and records the field as
heap (mirroring C), so the field owns an independent copy and the local's own
free stays sound.

The LEAK half is fixed too (2026-09-30), via fix direction 1 below: at every
call taking a `ref` value-struct param, the callee's definitely-executed
direct stores are transferred onto the caller's records
(`transfer_ref_param_field_records` / `scan_ref_param_string_field_writes` —
the same machinery that closed the ref-param FOLLOWUP entry, wired into all
four call builders). `dst.s = <fresh call result>` (Regex.find's
`dst.text = input.substring(...)`) and `dst.s = <heap-owned local>` now free
at the owner's scope exit on both backends; the covering tests run with audit
ON (test/ref_param_string_field.test.ts).

Residual (bounded leak, never an invalid free — the same posture
`drop_self_written_string_field_records` takes):

- Stores reached through a helper called from a nested position are not
  transferred: the final stored copy from such a chain leaks (the helper
  builds its own fresh record set and cannot see the caller's field
  ownership). Closing it needs cross-function must-executed (dominator)
  analysis.
- Stores reached through trait dispatch (vtable) are not scanned — see the
  trait-dispatch entry below.
- Direction 2 remains the systemic alternative: always-heap value-struct
  string fields (tier 3 in the trait-dispatch entry) would delete
  `heap_string_fields` and this whole class at a malloc-per-literal cost.

**Aliasing route closed by pass-by-value (2026-09-26).** The most common
route INTO this hole — passing an owning value struct as a plain
(non-`ref`, non-`move`) argument, which aliased the caller's storage by
address — is gone entirely: those arguments are now PASS-BY-VALUE (the call
boundary materializes a uniformly heap-owned copy the callee owns), so a
non-`ref` callee can never write through to the caller's struct. An earlier
check-time gate (`fn_writes_param_string_fields`, which rejected aliased
args only when the callee actually wrote the param's string fields) was
removed as superseded.

**Return boundary FIXED (2026-09-24).** The RETURN-boundary sibling of this
hole — a returned value struct's records were dropped at the boundary and the
caller never re-recorded them, leaking every heap string field — is closed by
return-boundary normalization: `build_return_node` (both backends) strdups
the returned struct's UNRECORDED string fields when the return is a BARE
LOCAL/PARAMETER (the transfer shape — the returned variable dies at the
return), making the value uniformly heap-owned (recorded fields transfer
raw). Every other shape keeps the status quo (borrow accessors such as
`Map.get`'s `load_T`, owned accessors, constructors) — normalizing those
leaks in expression-temp consumers nothing frees. The caller side records
via `record_call_init_string_fields`
(build_common/call_init_string_fields.ts), gated on the whole-program
pre-pass `gather_normalized_struct_returners`
(build_common/struct_return_classification.ts), which classifies at parse-
time-free AST level which functions normalize (every struct-return is a bare
local, transitively through forwarded registered calls) — a build-order
registry cannot work here (nested functions build after the enclosing
body's declarations consult it). Covered by
test/struct_return_normalization.test.ts.

## `Buffer`'s raw slot primitives are public, and `store_T` leaks on overwrite

`default_visibility` makes struct members `pub` by default, so `Buffer<T>`'s
low-level primitives (`alloc_T`/`grow_T`/`load_T`/`store_T`/`replace_T`/
`move_T`, plus the `_int` twins) are callable from user code — despite the
library treating them as internal implementation details. `store_T` assumes
a FRESH slot: its specialised body deep-copies the incoming value for owning
element types but does NOT free the previous occupant, so storing twice at
one index leaks. Verified on both backends (audit): `Buffer<string>` and
`Buffer<struct { var string }>` with `store_T(0, ..)` twice report
`LEAK: 1 allocation(s)`; the `replace_T` variant is balanced. `ClassBuffer`'s
`store_T` has the same shape for class pointers (leaks the displaced
instance). Contract comments were added to both.

Internal containers (`List`/`Map`/`Set`/`Arena`/…) are balanced — they use
`store_T` on fresh slots and `replace_T` to overwrite — so the leak is only
reachable by driving `Buffer`/`ClassBuffer` directly. Remediation shipped
2026-09-15 (test/buffer_modify.test.ts):

- **`modify_T(idx, f)` encodes the load→modify→store dance soundly** on both
  backends for every element kind: the primitive applies `f` to a live slot
  and owns the transition (displaced value freed; a returned field that
  aliases the slot's own copy — the round-trip identity — is kept, not freed
  or re-copied). Scalar elements round-trip through the raw width-matched
  body; string/owning-struct elements take the specialised bodies
  (owning_buffer_specialize.{ts} both backends); classes get
  destroy+free-of-displaced with an identity guard. Contract: the fn's
  returned owning fields must be fresh, null, or identical to the input's
  (no cross-field aliasing) — sound for closures-free lambdas, whose returns
  can only be fresh heap, boundary-normalised literals, or input-derived.
  `modify_T` is deliberately NOT `inline` (raw splices would bypass the
  per-element specialisations).
- **Enabler: func-typed params substitute `T` at monomorphization** —
  `substitute_param_signature` in check_function_call_node.ts now rewrites
  `param.func_params`/`func_return_type` (and `Type.func_params`) through
  the substitution map in all four clone loops; previously the C backend
  emitted `T (*f)(T)` for any generic method taking `func (T, out T)`.
  Also fixed en route: the C func-pointer signature now emits the struct
  TAG (pointer form for classes and traits) for struct/class/trait element
  types instead of `c_type` — the typedef form landed in the header before
  the element's typedef line ("type specifier missing").
- **aarch64 func-param calls now handle fat-pair args** — the
  `is_func_param` call path moved one register per arg; a `string` arg now
  occupies (xN, xN+1), matching the callee ABI (len half moved before the
  ptr half, which targets x1 for the first pair slot).
- Remaining exposure: the raw primitives are still public (option (c) below
  — plain `private` is scope-based (is_visible.ts) and would lock out the
  sibling System containers, so hiding needs a library-internal visibility
  concept). With `modify_T` + the contract comments, the safe path exists;
  (a)+(c-lite) is the accepted posture for now.

## Residual Buffer holes

1. **`store`'s fresh-slot contract: NOT removed (deletion was unsound).**
   Removing `store` and routing every caller to `replace` broke the
   load→modify→store round-trip uses (`JsonTree.set_kind`/`set_child`/…):
   `load` returns a shallow (aliasing) copy for owning structs, and `replace`
   frees the displaced value _before_ copying, so the aliased copy dangles.
   `store`'s round-trip guard is load-bearing. Closing the remaining leak (a
   `store` on an occupied, non-aliasing slot) needs per-element reclaim in the
   owning specializations while preserving that guard — a backend change
   deferred as its own task.
2. **`alloc` discarding: NOT changed (folding into `grow` changes semantics).**
   `alloc(n)` sets cap exactly `n`; `grow(n)` rounds up. Callers rely on the
   exact cap, and routing `alloc` through `realloc` also surfaced the
   swap-size codegen bug below as latent heap corruption. Reclaiming the old
   slab inside `alloc` while keeping the exact cap needs per-element destroy
   (owning `T`), so it is deferred.

## Kill-trampoline teardown for parked fibers (deferred)

Nursery cancel/timeout wakes a parked fiber (see `__nomen_future_cancel`) and
the fiber then exits cooperatively by polling `Task.current_cancelled()` at
its checkpoints — or by `Channel.receive` returning the zero value once
cancelled. Two cooperatively-reachable gaps were closed en route (closures
Phase 3d session):

- `Channel.receive`'s non-fiber wait now blocks in bounded slices
  (`__nomen_fiber_waitq_park`'s thread branch: 100 ms `cond_timedwait`
  re-checking the cancel flag), so a cancelled THREAD task returns the zero
  value within the join's grace instead of never observing cancellation.
- The nursery join, after cancelling on timeout/race, now waits for done
  UNCONDITIONALLY (both backends). The previous 1-second grace released
  futures whose tasks were still running and let the block exit free
  block-scoped resources (a Channel under a still-blocked receiver or a
  producer that touches it later) — memory corruption
  (test/kill_kick.test.ts reproduces both halves).

What remains of the kill-trampoline: a task that NEVER observes
cancellation (one long unobservable raw sleep, a tight CAS loop, a raw
blocking FFI call) now hangs its nursery's join instead of corrupting
memory — the join-before-exit contract holds, liveness doesn't. The full
fix remains the kill trampoline: push a teardown frame onto the parked
stack, switch to it, and let normal scope-exit `#destroy` unwinding run
every live frame. That needs forced stack unwinding of suspended frames
(or a longjmp-style teardown entry), a substantial runtime feature, and
until then cancellation is cooperative only.

## Advisory parking-lint content (remaining)

The lint is scoped to fiber-reachable code; the deadlock-design
discussion settled its content:

- Baseline: flag park-capable calls (`Task.result`/`result_uint64`/`wait`,
  `Channel.receive`/`receive_string`, `Mutex.lock`, `wait_for_io`-backed
  primitives) transitively reachable from a `Fiber(...).start()` — shows
  the wait edges without judging them.
- Channel-end advisory (uses existing move/borrow tracking): when a
  receive-end flows into a nursery and no send on that channel is reachable
  inside the block, note "waits on a producer outside this block" — the
  join-before-communicate shape, as a hint.
- Explicitly advisory, never a rule: produce-inside /
  consume-after-the-brace must keep compiling, and timeout/race recovery
  choreography relies on cross-block sends.

## Phase 4 remainder

Unchanged — the remaining Phase 4 items: 8 KB initial stacks + growth (guard
page + SIGSEGV handler vs compiler-inserted stack-limit checks), `await`
sugar, an io_uring runtime, the parking lint (above), plus the Phase 3
leftover: the 10k-connection acceptance run (N = 64 is the tested ceiling).
Recorded here as a pointer only; ASYNC.md's "Roadmap" is the source of truth.

## Opaque-closure spawn result leaks the original string (closure form)

The function-value spawn construction (`Thread(() => …)` / `Fiber(() => …)`, or
a moved func-typed local, or a named function) duplicates and leaks a `string`
result when the closure is opaque to the compiler. For a capturing lambda
literal the result is alias-checked against the captured strings and only
`strdup`'d when it aliases the env (balanced, no leak); for a capture-free
literal it transfers as-is. An opaque closure (a moved func-typed local, or a
named function materialized as a thunk) instead gets `nomen_str_dup(_r)` with
the original leaked — "leak-never-dangle", bounded at one allocation per run
(`src/build_c/build_magic_ctor.ts:395-429`, aarch64 `:284-317`;
docs/ASYNC.md:103).

The direct-call form (`Thread(fn(args))`) is unaffected: its trampoline calls
the function and stores the result with no aliasing question. Posture decided
in docs/ASYNC.md ("Design decisions"): keep the documented leak for now. Possible fixes if it
matters: extend the closure descriptor ABI to carry result ownership so the
adapter can transfer vs duplicate exactly, or reject an opaque string-returning
closure with a diagnostic (forcing a lambda literal whose captures the compiler
can see).

## `Fiber.start_on(buf)` runs on a heap stack (spec/impl gap; last name-keyed launch site)

The async migration (docs/ASYNC.md, "Design decisions") made `Thread.start`/`.detach` and `Fiber.start` ordinary
library methods, but `Fiber.start_on(buf)` remains special-cased: the checker
validates the compile-time stack buffer (`check_spawn_start_on` — fixed-size
array, ≥ 16 KB) and then REWRITES the access to the ordinary `Fiber.start`
(`src/check/check_access_node.ts` — the `target_type.name === "Fiber" &&
node.name === "start_on"` arm). The fiber therefore runs on a HEAP stack,
never the caller's buffer — on both backends, and it always did: the old
checker never even stamped `is_fiber_start_on`, so the build's `spawn_on`
emission was unreachable and the committed runtime tests passed on heap
stacks. The phase-1 change exposed that latent gap rather than creating it.

Two things are missing to make it real:

1. **Storage for `T[N]` no-init declarations.** `var uint64[2048] stack_buf`
   lowers to an UNINITIALIZED `T*` element pointer in the C backend
   (`build_declaration_node`: a stack C array requires a literal/range
   initializer) — there is no buffer to hand the fiber. Both backends need a
   no-init `T[N]` form that materializes the caller's storage (or an explicit
   zero-init/`uninit T[N]` spelling).

2. **A method-body representation of the buffer's compile-time byte size.**
   `Fiber.start_on`'s raw body needs `len * sizeof(elem)` (strings are the
   16-byte fat pair, everything else one word). A method signature has no
   way to accept "any fixed array, byte size known at compile time": no
   sized-array parameter form, and no `T_SIZE`-style substitution for a
   parameter's element size (the existing constants substitute for the
   class's own type param, not an arbitrary param type).

When both exist: declare `start_on` as a real `Fiber` method over the
runtime seam (mirroring `Thread.start`'s body), delete the checker rewrite,
and the last name-keyed launch dispatch is gone. It can stay Fiber-specific
(embedded/no-heap path); `Spawnable<T>`'s surface remains `start`/`detach`.
Until picked up, the surface contract holds — the ≥ 16 KB fixed-array
validation is a compile error — and the runtime behavior (heap stack) matches
the pre-migration compiler exactly, so nothing regressed; the SPEC's
"caller-provided fixed-size array stack" sentence (SPEC.md, Fiber section) is
the documented-but-untrue bit.

## aarch64: pure-Nomen 64-bit arithmetic emits looser code than a raw `#arch` body

`Random.next` (splitmix64) was rewritten from a raw `#arch: c`/`#arch: aarch64`
pair to pure Nomen — verified bit-identical by `test/random.test.ts`'s exact
BigInt reference on both backends. The C backend lowers it identically (one
native op per step), but the aarch64 output is ~40 instructions where the
hand-written body was ~14 (all cheap ALU ops, still call-free):

```
self.state = self.state + 0x9E3779B97F4A7C15
var uint64 z = self.state
z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
z = (z ^ (z >> 27)) * 0x94D049BB133111EB
return z ^ (z >> 31)
```

The gaps, if this ever becomes hot (or `Random` lands in a tight loop):

1. **Constant materialization.** Each 64-bit literal becomes `movz` + three
   `movk` (4 instructions); the raw body used one `ldr xN, =CONST` from the
   literal pool. Hoisting the three constants into `const uint64` locals does
   not currently help (`asm_remat`/`asm_coalesce` do not fold them here).
2. **Field-value forwarding.** `self.state = …; var z = self.state` stores and
   then reloads the field (`str x0, [x19, #8]; mov x0, x19; ldr x0, [x0, #8]`)
   instead of keeping the value in a register.
3. **Immediate shift counts.** `z >> 30` does `mov x0, #30; lsr x0, x12, x0`
   rather than an immediate `lsr x2, x0, #30`. Same for the `mov x1, x0`
   leftovers around the multiplies.

Neither the C backend nor correctness is affected — this is a code-quality
note only. Two ways to close it: restore the raw `#arch` bodies (the git
history has them, plus the pre-rewrite `Random.nm`), or teach the aarch64 ASM
optimizer the three folds above (which would benefit all pure-Nomen 64-bit
arithmetic, not just this generator).

## Redundant statement terminator after `return` (cosmetic)

Every C `return` emits its own `;\n`, and the statement tail then appends
another `;\n` (via `with_semicolon_tail` / `build_node`'s `with_semicolon`
suffix), yielding a stray `;` on the next line after each `return`:

```c
return _return_val;
;
```

Harmless dead text, and byte-identical in both the NIR-native and delegated
statement paths. Removing it would need `return` added to
`statement_ends_with_block` and every code-text test expectation updated, so
it is left alone (recorded here as noted-out-of-scope, not a correctness
issue).

## `move` on owning value-struct field declarations is redundant (cleanup)

The compiler derives ownership of `List`/`Buffer`/owning-value-struct fields
from the TYPE, not the keyword: `mark_owning_auto_init_params`
(src/check/check_struct_node.ts) auto-stamps the synthesized `#init`
parameter `is_moved` for any field whose type satisfies
`is_owning_struct_type_requiring_move` (the monomorphized-struct path
mirrors this in check_function_call_node), and the destroy /
displaced-value-reclaim / pass-by-value paths key on that same type
analysis. So `pub move items = List<string>()` and
`pub var items = List<string>()` behave identically — the keyword is dead
weight on value-struct field declarations.

The allmark port writes a few of these (`pub move List<int> items`);
sweep them to plain `var`. KEEP the keyword on CLASS-typed fields, though:
there `move` is the ownership DECLARATION (container owns + destroys the
instance, eagerly reclaims displaced assignments, and borrow stores are
rejected), and own-vs-borrow is observable behavior — not inferable the way
tuple-literal last-use moves are. Worth considering alongside the sweep: a
checker warning for `move` on value-struct fields so it does not
re-accumulate, and a line in docs/MEMORY.md stating that field `move` is
meaningful only for class-typed fields.

## Owned string stored into a ref-param struct field (fixed; bounded remainders)

FIXED (2026-09-30), both backends. The store itself was never the problem —
the record was: the callee's `heap_string_fields` records are scope-local and
died at return, so the caller never freed the stored copy (LEAK: 1 per
call). Worse, the record SET was shared across function builds: a callee's
`p.a` record leaked into a LATER function's build, and a same-named local of
an UNRELATED struct matched it — its scope exit freed a rodata literal
(invalid free, SIGABRT), not just a leak.

Two halves close it:

- **Per-function record isolation.** `heap_string_fields` joins the other
  name-keyed sets saved/restored around each function body build (both
  backends; the struct custom-`#init` body paths too). Records now cross a
  call boundary only deliberately.
- **Call-site transfer (the add-direction mirror of
  `drop_self_written_string_field_records`).**
  `transfer_ref_param_field_records` (build_common) consults
  `scan_ref_param_string_field_writes` — the callee's DIRECT top-level
  stores through `ref` value-struct params, transitively through top-level
  calls that forward the same param (resolved via the checker's
  `resolved_function` stamps) — and records the fields for the ARGUMENT
  variable at the call site, so the argument's owner frees them at its
  scope exit. Wired into all four call builders (free function + method,
  both backends). Covered by test/ref_param_field_transfer.test.ts.

Soundness rule: only definitely-executed (direct) stores transfer; a
conditional store could leave the pre-call value in place, and a record over
it would free rodata at the caller's exit. Bounded remainders (leak, never a
double/invalid free — same posture as the cross-scope entry above):

- A displaced copy from an EARLIER call leaks per extra call
  (`set(ref p, "one"); set(ref p, "two")` leaks "one"): the callee's store
  cannot know the displaced value's ownership, and pre-freeing at the call
  site would be a use-after-free when the callee reads the field first.
- A conditional field's entry-dup displaces whatever pre-call value the
  field held, un-freed (≤1 per call): the callee can't know whether that
  value was heap or a rodata/borrow.
- Stores reached through a helper called from a nested position are not
  transferred (the final stored copy from such a chain leaks).
- Stores through a `ref` param reached via trait dispatch (vtable) or an
  inlined method are not scanned — see the trait-dispatch entry below.

## Owning container fields in container elements (transfer + load deep-copy)

FIXED (2026-09-30), both backends: a value struct with a heap-owning
container field (`var protocols = List<string>()`) pushed into a
`List<that-struct>` aborted at teardown (`free of object 0x4`, exit 134).
Root cause: the owning `Buffer_<T>` specialization deep-copied only STRING
fields, so the slot and the source SHARED the `List<T>` member's buffer,
while every struct-local teardown destroys container fields unconditionally
(and the aliasing `at()`/`load_T` result did too). Fix:

- `store_T`/`replace_T` now TRANSFER the element's owned container fields:
  the slot's bytes were memcpy'd, so the SOURCE's container leaves are zeroed
  (`emit_transfer_owning_fields` C / `collect_transfer_fields` aarch64,
  recursing through nested value structs). The source's own teardown then
  reclaims nothing; a spliced `move` donor needs no teardown at all.
- `load_T` IS now specialized: the returned copy deep-copies `List<T>` fields
  (`<List_T>_copy`) — the caller's scope-exit destroy would otherwise free the
  slot's buffer. String fields stay borrowed (struct-local teardown only frees
  RECORDED heap strings, so strdup'ing on load would leak).
- The auto-derived `copy` now synthesizes a DEEP copy for `List<T>` members
  (`c.protocols = self.protocols.copy()`) instead of the old shallow share,
  and its eligibility gate is order-consistent (`struct_is_copyable`
  re-evaluates a shape-based predicate instead of resolving monos at derive
  time).

Covered by `test/list_struct_heap_members.test.ts` (teardown + copy
independence, audit ON, both backends).

Remaining gaps (all bounded to non-`List` container fields / class/enum
element fields; none hit by the allmark port, which uses `List` fields and
class-based rule types):

- **`load_T` deep-copies `List`/`Buffer` fields only** (and, on C,
  payload-copyable enums). A `Map`/`Set` field, a nested owning user struct
  field, or a class-typed field of a container element is still returned
  SHALLOW: the caller's scope-exit destroy frees the slot's shared state
  (double-free). `Map`/`Set` have a hand-written `copy`, but it is EXCLUDED
  from the automatic deep copy (`is_load_deep_copy_container`) because
  composing it from the `load` specialization corrupts the returned struct
  on aarch64 (open — the load sret + `<Map>_copy` interaction). Nested owning
  user structs need a
  synthesized `copy` story (the auto-derive gate `field_copyable` does not
  yet accept `Buffer`/`Map`/`Set` fields). Same for enum-with-data element
  fields on aarch64 (C handles them).
- **`Map`/`Set.copy` for class/trait values is unsupported.** A generic
  `Map.copy` body calls `self.values.copy()`, but a class-valued Map's member
  is a `ClassBuffer` with no `copy`; instantiating it emits a call to a
  nonexistent `ClassBuffer_<C>_copy` (link error). A class/trait deep copy
  needs a designed clone story (same posture as `List.copy`, which the checker
  rejects for class elements).
- **`store_T`/`replace_T` transfer only container leaves** (recursing nested
  structs). Class-typed and enum-with-data fields of the element stay shared;
  for a stamped `move` donor this is sound (spliced → the slot is sole owner),
  but an UNSTAMPED generic-body donor (the library `List.copy` body's `v`)
  whose teardown destroys a class field can still double-free. Adding
  class/enum payloads to the transfer set would close it.
- **A value-struct assignment** (`b = a` for a struct owning a `List`) is
  rejected by the checker (`use .copy() or move`); `.copy()` is the deep path.

## `nomen test` bench numbers were debug-build timings (FIXED 2026-10-01)

`t.bench`/`bench_loop` harnesses compiled by `nomen test` always built
unoptimized: `run_test_file` never passed `optimize` to `build()` and
linked with bare `clang` (no `-O2`), and the CLI's `test` branch never
forwarded `args.release` — so bench timings were debug-mode while
`bench/benchmark.sh` (which defaults `compile_nomen.ts` to release) told a
different story. Fixed: `RunTestsOptions.release` threads through to
`build({ optimize })` + a `-O2` link line; `nomen test --release` opts in
(default stays debug, matching `run`/`build`). Covered end-to-end by
`test/test_harness.test.ts` running the calc fixture in both modes.

## `last_result_is_heap` is side-channel state (discipline enforced; structural rewrite optional)

CLOSED as a bug class (2026-10-03): an audit of every consumer found exactly
one without the reset-first discipline — the aarch64 ctor's
`init_expr_field_default` read whatever the previous field's emission had
left, so a heap-setting default (a call) before a non-flag-setting default (a
grouped literal) skipped the strdup and stored rodata in an always-heap class
field (`test/ctor_default_stale_flag.test.ts` repro: AUDIT-STALE-FREE). It
now resets first. build_block_node additionally clears the flag at every
statement boundary (main's module-init prologue included), so even a future
consumer that forgets reset-first reads the safe default (false → copy →
bounded leak) instead of the previous statement's value (→ free of borrowed
bytes). The reset-first contract is documented on the BuildStatus field.

Remaining (deliberate): the flag itself is still side-channel state rather
than an ownership value threaded through the RHS emitters (`{ heap: boolean }`
returns). That rewrite touches every emitter and the NIR seam for no
correctness gain under the enforced contract — worth it only if the flag
grows more consumers or the bounded-leak default becomes a measured problem.
