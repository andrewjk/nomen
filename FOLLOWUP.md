# Follow-ups

Skipped or out-of-scope items recorded for later.

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

Converting the allmark markdown library (~170 TS files) to Nomen hit the
following. The port currently builds around all of these (traits instead of
func fields, `Map<string, int>` indices instead of reference-valued maps,
`--arch c` for the aarch64 mis-binds, no string-literal defaults on class
fields), but each should be fixed in the compiler:

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

## Bare `Thread(fn(args))` construction is inert and unchecked (ASYNC_PLAN Phase 0)

`Thread(fn(args))` is a compiler-special constructor (see
`check_thread_ctor` in `src/check/check_function_call_node.ts`). It is meant
to be consumed immediately — by `.start()` (direct spawn) or by
`name.start(Thread(...))` (the nursery escape hatch). A construction that is
never consumed (e.g. `var t = Thread(work(0))` with no `.start()`) type-checks
(it is stamped with the inert type `Thread`, which has no fields or methods)
but spawns nothing, and the checker never flags it. Downstream, the C backend
would try to emit a call to an unresolved `Thread` function, producing an
unhelpful link-time error.

Fix idea: a small post-check pass (or a declaration/assignment-side check)
that rejects a `Thread`-typed value that is never consumed by `.start()` /
`nursery.start(...)`, with a message like
"`Thread(fn(args)) must be started: append .start() or pass it to a nursery's .start()`".
Low priority — the form is degenerate misuse, but the current failure mode is
confusing.

## Kill-trampoline teardown for parked fibers (ASYNC_PLAN Phase 2, deferred)

Nursery cancel/timeout wakes a parked fiber (see `__nomen_future_cancel`) and
the fiber then exits cooperatively by polling `Task.current_cancelled()` at
its checkpoints — or by `Channel.receive` returning the zero value once
cancelled. A fiber that never polls its flag (a tight CAS loop, or a raw
blocking call) still holds up the nursery join. The ASYNC_PLAN design for
this is a kill trampoline: push a teardown frame onto the parked stack,
switch to it, and let normal scope-exit `#destroy` unwinding run every live
frame. That needs forced stack unwinding of suspended frames (or a
longjmp-style teardown entry), which is a substantial runtime feature and was
out of scope. Until then cancellation is cooperative only.

## Nursery futures list is capped (Phase 3, partially fixed)

`test/tcp.test.ts`'s scale test failed with `echoed 0/N` for N >= 64. Root
cause: the nursery's futures collection was a fixed stack array
(`unsigned long long futures[64]`), so the 65th registration wrote past its
end (memory corruption; the failure threshold was exactly N = 64 with N = 63
passing). Fixed by allocating the list on the heap (65536 entries) on the C
backend and, on aarch64, an 8-byte stack slot holding a heap pointer
(a larger stack array would have pushed later frame offsets past the
4095 immediate limit — large locals on aarch64 now work via the
large-frame access shims, but the heap list also keeps the frame
small). The N = 256 echo test now passes on both backends.

Remaining: the capacity is still a cap (65536 per nursery), and the aarch64
call sites now load the pointer from the slot. A growable list (realloc with
a capacity slot, or a linked list of futures) would remove the ceiling and
shrink the per-nursery allocation (512 KB is allocated even for tiny blocks).

## C user TUs cannot compile module-level statements (system_lib split)

In the C backend's system_lib split, a user TU whose MODULE scope carries
statements (`var Channel ch = Channel()` or a module-level `async` block —
anything outside a func) emits those statements at C file scope
(`struct Channel *ch = Channel_init();` bare, then the async block's
nursery bookkeeping), which fails to compile ("initializer element is not a
compile-time constant", stray `{`). Verified on the unmodified baseline, so
it is pre-existing and unrelated to the runtime-sharing change; module-level
`var`/`async` in a single-TU ("all") build is fine. Every test sidesteps it
by keeping statements inside `main`, so the split path is undertested for
this shape — worth fixing in `build_block_node`'s module-statement hoist
(wrap them in the generated `main`, as the single-TU path does) and adding
a split-build regression test when picked up.

## aarch64 system object cannot carry `aarch64_use_c` bodies (Phase 3 follow-up)

The aarch64 system library is built as assembly only — its companion C file is
never linked (`test/system_lib.ts` writes `system.s` -> `system.o`). Any
*library* function whose body is `aarch64_use_c` lands in that companion, so
the system object references symbols nothing defines (`undefined symbol
Tcp_listen_fd`, …) and every test linking `system.o` fails. `Stream/Tcp` is
therefore excluded from the canonical system program (it compiles in the user
TU, like the GUI types); `Stream/Http` also had to keep its raw blocking
bodies, since porting it onto Tcp would make a library type depend on Tcp.

Attempts and outcomes (do not repeat blindly):
1. `ld -r` merging the system companion into `system.o`: links, but the
   resulting object segfaults plain aarch64 programs.
2. Compiling the companion and linking it as a **separate object** next to
   `system.o` (infrastructure is in `system_lib.ts` / `check_output.ts`):
   same symptom — plain programs segfault as soon as the system companion is
   linked, even when they never touch its functions. The companion content
   itself is fine (identical bodies work in user companions), so the fault is
   in how the system companion object interacts with the system asm object or
   the link line (candidates: the audit wrapping applied to the user TU but
   not the companion, a duplicate/conflicting data symbol, or the
   `.subsections_via_symbols`/`.space` divergence noted in
   `system_lib_worker.ts`).

Until this is understood, keep library code that needs `aarch64_use_c` out of
the canonical system program.

