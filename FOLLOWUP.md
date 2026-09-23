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

## Heap return temp of an indirect call leaks when consumed by an operation (aarch64)

A fresh-heap value RETURNED from a call through a func-typed VALUE (`f(...)`
where `f` is a func-typed param/field/local) leaks on the aarch64 backend
when the result feeds an operation. Repro (audit on, aarch64 only):

```
struct Shout {
	func exclaim = (self, func (out string) f, out string) { return f() + "!" }
}

var Shout s = Shout()
var string r = s.exclaim(func (out string) { return 42.to_string() })
// r == "42!" — but the callee's to_string() buffer (f()'s result,
// consumed as the concat's left operand) leaks: LEAK: 1 allocation(s)
```

Verified CAPTURE-FREE (the lambda holds nothing), so it is not the
descriptor-dispose machinery — that is balanced. The C backend is clean
for the same program: its op-level tracking (`last_result_is_heap` /
`is_owned_heap_temp`) frees a consumed call-result operand, while the
aarch64 indirect-call paths (build_function_call_node's `is_func_param`
arm, build_access_method) appear never to mark their result as a heap
temp for that free pass. Suspected fix: give the aarch64 indirect call
the same heap-result marker the direct-call path gets from
heap_returning_functions, scoped to operands consumed by value ops.
Discovered while probing the inline-capturing-lambda fixes; direct
returns (`var string s = f()`) and borrow returns are unaffected.

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

## `return` inside an `async { }` block skips the nursery join (leak + soundness hole)

A `return` lexically inside an `async { }` block is emitted BEFORE the block's
join loop, leaving the join (and its per-future release) unreachable. Found
while writing `demos/async`: a coordinator that returned the concatenated task
results from inside its nursery leaked every task's machinery (future, result
slot, cancel flag, closure, env — ~6 allocations per task) because the
nursery's `__nomen_future_release` loop never ran; the `result()` calls had
already joined the tasks, so only the nursery's reference leaked.

```
func run_fetch = (out string) {
	async {
		var Task<string> ta = Thread(sleep_letter("A")).start()
		...
		return ta.result() + tb.result()   // emitted before the join loop
	}                                      // <-- join loop lands here: dead code
}
```

Both backends are affected (the async block builders emit
`body → join loop → auto_free`, and the return path in the body short-circuits
past them). This is more than a leak: the block's join-before-scope-exit
contract is the structured-concurrency guarantee, so an early return also lets
block-scoped resources die under still-running tasks. Fix shape: route a
`return` inside an async block through the block's join (like `break`/
`continue` reclaim enclosing scopes — see `free_scoped_declarations` in
build_break_node), or hoist the return value into a block-local and emit the
return after the join (what the demo does as a workaround).

Discovered 2026-09-23. Workaround in `demos/async/src/main.nm`: assign to a
local inside the block, return after it.

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

## aarch64: string accumulation in a loop inside `async { }` silently yields ""

Found while writing `demos/async`. On the aarch64 backend, assigning a
concatenation to an outer `string` local inside a loop inside an `async { }`
block leaves the local EMPTY (and leaks); the same code outside the block —
or a single non-loop assignment inside it — is correct, and the C backend is
correct in both shapes:

```
func in_async = (out string) {
	var string s = ""
	async {
		var int i = 0
		while i < 3 {
			s = s + "y"      // s stays "" and the block's concat temps leak
			i += 1
		}
	}
	return s                 // ""
}
```

Isolated shapes: plain loop → `"yyy"`; single assignment inside async →
`"A B "`; loop inside async → `""`. The demo works around it by draining the
channel AFTER the nursery join (loop outside the block). Likely the async
block's per-invocation frame and the loop's string-slot writeback/promotion
disagree (the block builder plus `asm_loop_promote`); the return reads a stale
slot. Not investigated further — real codegen bug, worth a focused repro
against the aarch64 ASM optimizer.

## aarch64: audit counts go negative for fiber programs that use string channels

An audited aarch64 build of a fiber that parks/resumes over a `Channel` with
`send_string`/`receive_string` reports `LEAK: -N allocation(s)` — more
`nomen_free_wrap` calls than `nomen_malloc_wrap`. The program is
memory-correct (correct output, no crash, both backends agree), and the
equivalent main-thread receiver counts zero
(`test/task.test.ts`'s `channel_string_payload_*` passes with audit on), so
this is an accounting asymmetry, not a double free — likely a raw
`malloc`/`strdup` in the aarch64 library asm (or the companion runtime)
paired with an audit-wrapped free, or vice versa, along the fiber park/resume
path. The new `fiber_p2_channel_string_wake_*` regression test runs with
`audit: false` for this reason. Worth reconciling so fiber programs can be
audited cleanly.
