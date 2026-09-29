# Follow-ups

Skipped or out-of-scope items recorded for later.

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

## Override-constructor returns are not normalized

Return-boundary normalization covers a plain struct-constructor return
(`return R(a, b)`): every string field is strdup'd unless the argument already
owns heap, and the function is registered so callers record/free the fields
(`struct_return_classification.ts` + both `build_return_node`s). The
ANONYMOUS override constructor (`return [ .. R(), field = local ]`, a
`func_call` with `field_overrides`) is deliberately EXCLUDED: when such a
return feeds an anon-struct BASE literal assigned to a binding, the caller
does not record the normalized fields, so normalizing leaks. A returned
override struct that stores a heap local into a string field can therefore
still dangle when the callee's scope exit reclaims the local. Fixing needs
caller-side recording through anon-struct base positions.

## Nullable scalars: remaining in-band corners

Nullable scalars (`bool?`, `int?`, …) now carry a companion `<slot>_has` flag
(locals, params, returns, struct/class fields; both backends — see
`src/build_common/nullable_scalar.ts` and `test/nullable_scalar.test.ts`).
These corners still use the old in-band `null == 0` representation:

- **Container / array elements** (`List<int?>`, `Buffer<bool?>`, `int?[]`):
  element storage is sized from the type name with no flag slot, so `0`/`false`
  read back as null again. Fixing needs per-element flag storage in the
  containers' raw T-generic bodies (or forbidding nullable element types).
- **Nullable enums / bitsets** (`MyEnum?`): represented as a bare tag word;
  `null` is tag 0 (conflates with the first case). Would need the same flag
  treatment, keyed on `is_nullable` + non-built-in.
- **Top-level (file-scope) nullable scalar globals**: the declaration reserves
  the flag and treats the global as null; a non-null initializer is NOT applied
  on either backend (the C path emits a static flag but skips the generic
  `= value` static init; aarch64 emits `.space`). Top-level nullable scalars
  are rare, but `var int? g = 5` currently reads null.

Also, aarch64 nullable scalar method/function returns used as a plain
(non-null) value allocate a discard sret temp (the nullness is dropped, never
diagnosed) — matching the C backend's disposable compound-literal `_ret_has`.

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
quadratic before the fix). If large-program aarch64 builds need more
headroom, the post passes want the same treatment: single-pass line
scans, cached label/classification lookups, and skipping the lift when a
pass makes no edits.

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

**Aliasing route closed by pass-by-value (2026-09-26).** The most common
route INTO this hole — passing an owning value struct as a plain
(non-`ref`, non-`move`) argument, which aliased the caller's storage by
address — is gone entirely: those arguments are now PASS-BY-VALUE (the call
boundary materializes a uniformly heap-owned copy the callee owns), so a
non-`ref` callee can never write through to the caller's struct. An earlier
check-time gate (`fn_writes_param_string_fields`, which rejected aliased
args only when the callee actually wrote the param's string fields) was
removed as superseded. The leak below therefore survives only for explicit
`ref` parameters — the shapes in this entry — bounded per write.

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

## Stale `cli/core` asset copy shadows the repo `core/` in dev

`cli/scripts/bundle-assets.mjs` copies repo `core/` → `cli/core/` for
packaging. `find_bundled` prefers `cli/core`, so a STALE copy (from an old
`pnpm build`) silently wins over the current `core/` while it exists — a
debugging tar pit (symptoms: monomorphized System bodies emit pre-closure
ABI code, everything works in a fresh worktree). Dev suggestion:
`find_bundled` should prefer `../core` (repo layout) when it exists, or
bundle-assets should stamp the copy with the source mtime so staleness is
detectable. Interim workaround: `rm -rf cli/core` after pulling changes.

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
