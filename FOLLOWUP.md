# Follow-ups

Skipped or out-of-scope items recorded for later.

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
quadratic before the fix). If large-program aarch64 builds need more
headroom, the post passes want the same treatment: single-pass line
scans, cached label/classification lookups, and skipping the lift when a
pass makes no edits.

## Inline capturing lambda as a direct call argument leaks its descriptor

A capturing lambda passed INLINE as a func-typed call argument
(`apply(func (out int) { return base * 3 })`, same for the arrow form
`apply((out int) => base * 3)`) leaks 2 allocations (heap closure
descriptor + env) on both backends, audit-verified. The parameter is a
BORROW (CLOSURE.md) — the callee never disposes — and the call site
materializes a one-shot heap temporary with no binding to run the
free-if-owned arm at scope exit. Capture-free inline lambdas are fine
(static descriptor, nothing owned), and binding to a func-typed local
first is the audited-clean pattern (`var func (out int) f = ...;
apply(f)`).

Fix shape: the checker already recognizes the shape (the func-param guard
in check_function_call's arg loop, `arg_is_func_binding` / literal-lambda
`node_type === "func"`); the backends would need to dispose a temporary
heap descriptor after the call returns for exactly those args (stamped at
check time). Kept out of the lambda-forms change to stay scoped.

## Cold-run parallel test flakiness (pre-existing)

A fully cold `npm test` (after `rm -rf test/out`) with default file
parallelism shows ~25-35 spurious failures (empty `output.txt` files written
for tests whose binaries run fine standalone — e.g. `file.test.ts`,
`ziglings/107_files2.test.ts`, plus a broad scatter). Reproduced on the
unmodified baseline (changes stashed), so it is not a codegen regression.
A second (warm) run is fully green, and a cold run with
`--no-file-parallelism` is fully green — it looks like a
concurrency/caching artifact in `check_output`'s cache write under load.
Worth investigating `test/check_output.ts`'s `outputfile`/`cachefile` writes
if it keeps biting.

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

## Cross-scope string field stores leak the stored copy (accepted, bounded)

The dangling half of this is FIXED. Assigning a heap-owned string local into
a struct field through a `ref` struct parameter used to raw-store the local's
(ptr, len) and then reclaim the buffer at the local's scope exit — the field
dangled the moment the callee returned (C was correct; it strdups). The
aarch64 backend now strdups the pair at the store and records the field as
heap (mirroring C), so the field owns an independent copy and the local's own
free stays sound. Covered by test/ref_param_string_field.test.ts.

What remains — and was already true before the fix — is a LEAK for every
cross-scope owning store, because `heap_string_fields` records are
scope-local: the record that "this field holds heap" lands in the CALLEE's
scope and dies at return, while the field lives in the CALLER's variable,
whose scope exit never frees it.

- `dst.s = <fresh call result>` (e.g. Regex.find's
  `dst.text = input.substring(...)`) — transferred raw; the buffer leaks.
  Pre-existing; invisible until audited because the covering tests ran with
  audit off.
- `dst.s = <heap-owned local>` — the strdup'd copy leaks (new since the
  dangle fix; strictly better than the corruption it replaces).
- Repeated stores free each displaced copy (`old_was_heap`); only the final
  value leaks, so the leak is bounded by fields, not stores.
- Same-scope stores (`b.s = s` where `b` is the local being stored into) and
  class fields are fully balanced — the record (or the class destroy) frees
  at the owner's scope exit. test/ref_param_string_field.test.ts asserts the
  same-scope shape with audit ON and the cross-scope shapes with audit OFF
  (they report `LEAK: 1 allocation(s)` by design).

Posture: leak, never double-free/invalid-free — the same trade
`drop_self_written_string_field_records` makes for displaced `self`-writes.

Fix directions, when picked up (either closes the leak class):

1. **Caller-side record propagation.** At each direct call `fill(ref b)`,
   scan the callee (transitively, like `scan_self_string_field_writes`) for
   writes to its ref params' string fields, then add/refresh the caller's
   `b.s` record so the owner's scope exit frees. Soundness needs
   must-executed (dominator) + always-heap analysis: a record over a field a
   not-taken store left holding a borrow would free rodata at exit. Shapes
   that can't be proven keep the leak.
2. **Always-heap value-struct string fields** (tier 3 in the trait-dispatch
   entry above): strdup on every assignment including literals,
   `<Struct>_destroy` frees every field. Deletes `heap_string_fields` and
   this whole class; costs a malloc per literal store into a value struct.

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

## Stale `cli/core` asset copy shadows the repo `core/` in dev

`cli/scripts/bundle-assets.mjs` copies repo `core/` → `cli/core/` for
packaging. `find_bundled` prefers `cli/core`, so a STALE copy (from an old
`pnpm build`) silently wins over the current `core/` while it exists — a
debugging tar pit (symptoms: monomorphized System bodies emit pre-closure
ABI code, everything works in a fresh worktree). Dev suggestion:
`find_bundled` should prefer `../core` (repo layout) when it exists, or
bundle-assets should stamp the copy with the source mtime so staleness is
detectable. Interim workaround: `rm -rf cli/core` after pulling changes.
