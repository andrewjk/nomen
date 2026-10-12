# Follow-ups

Skipped or out-of-scope items recorded for later.

## Struct-plan residuals

(The plan documents are consolidated in [`docs/STRUCTS.md`](./docs/STRUCTS.md);
the "STRUCT_PLAN_3" labels below are its section names.)

The class retirement (Phase R) and the struct/move refactor (Phases B/D)
have landed: `class` is retired with a dedicated parse error, the Copyable
verifier runs over declared ownership, `string` is a declared mv type,
and the mv-struct string-field lowerings are uniform-heap on both
backends. What remains:

### Docs debt (user-facing, teaching retired syntax)

- **`docs/BORROW.md`** still teaches the retired `mov` keyword and the
  pre-B5 "structs cannot hold class-typed fields" rule — it needs a full
  rewrite to the `mv`/mv-field world.
- **`docs/ASYNC.md`** still teaches `Sendable`-gated class spawning
  (SPEC.md/README.md were rewritten in tranche 4's en-route work; the
  shipped rule is that trait handles cannot cross a task boundary and
  structs auto-derive). It also cites the opaque-closure spawn leak (see
  that section below).

Neither should be cited as current syntax until rewritten.

- **`docs/GUI.md`**'s "Why handle-based, not trait-based" rationale section
  still quotes pre-`mv`-era errors (`mov Trait` params) and pre-R trait
  constraints — its conclusions mostly still hold, but the cited syntax and
  error text are two renames stale.

### Test-corpus skips that name live gaps

Each skip masks a real post-R/B1/D3 gap (verified still failing
2026-10-09):

- **`operations` (2) + `interpolate_string` (1)**: compile-time
  division/modulo-by-zero detection — a language-feature ask ("TODO: This
  needs runtime protection"), not a backend bug.

### B1 residual (checker)

- A generic struct mono with a bare-`T` field derives `is_owning` (the
  mono verifier then passes), but the generic TEMPLATE itself is never
  flagged — `mv struct Wrapper<T>` must be spelled when every
  instantiation should be mv.
- Variadic-pair extraction of mv elements (`Map`'s pairs init) rides
  the temp-rooted read exemption in `check_function_call` (the temp dies,
  set's store deep-copies) until a generic move-out accessor exists on
  Array.

### D3 residuals (`string` is mv)

- **`string` captures are read-invalidated but memory-snapshotted**: the
  E2 endgame (a real transfer) is deferred; the current model is sound
  and matches the pre-D3 output for capture-then-reassign shapes.

### Trait-typed FIELDS on mv structs (the B5 remainder)

Rejected with a named fix ("declare it with the concrete type, or
`Box<Concrete>`") until the boxed-handle field lowering exists — field
storage as a `void*`-shaped handle plus vtable dispatch THROUGH a field
(both backends; the aarch64 field-shaped dispatch path still carries the
pre-B4 inline shape and the C field member type needs `void *`). Not in
the R shape menu (fields hold concrete types / `Box` / `WeakHandle`), so
this may stay rejected permanently if R doesn't need it.

### B4 residual corners (deliberate, recorded for later)

- **Root-scope trait consts** (`const Named n = Alice()`) are still
  inlined at use sites via `top_level_consts` — each use re-derives the
  box (and a use as a bare value re-runs the constructor). Fine for
  constants; revisit if root-scope trait bindings need identity.

## `Shared<T>` + the `with(m)` critical-section form + typed `Mutex<T>` (N4 remainder)

STRUCT_PLAN_3 Phase N's N4 is otherwise complete (`Atomic<T>`, the
protected-slot freeze derivation, ref-arg spawn borrows); this is the
deliberately deferred remainder, recorded 2026-10-05 in
`PROGRESS_PHASE_N.md`:

- **`Shared<T>`** — the lock-guarded slot type, reachable only through the
  mv lock's critical-section form.
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
a dedicated error (List `set` takes `mv T`, so the array writeback
shape doesn't transfer — needs its own design).

## Ownership-tracking remainders (string fields through calls)

The per-call record/transfer machinery closed the dangling and leak halves
of ref-param field stores (see git history: cross-scope stores, ref-param
transfer, return-boundary normalization). These bounded remainders remain
— leaks unless noted, never dangling on the verified shapes:

- **A displaced copy from an EARLIER ref-param call leaks per extra
  call** (`set(ref p, "one"); set(ref p, "two")` leaks "one", verified
  2026-10-09): the callee's store cannot know the displaced value's
  ownership, and pre-freeing at the call site would be a use-after-free
  when the callee reads the field first.
- **Stores reached through a helper called from a nested position are not
  transferred**: the final stored copy from such a chain leaks (the
  helper builds its own fresh record set and cannot see the caller's
  field ownership). Closing it needs cross-function must-executed
  (dominator) analysis.
- **A conditional field's entry-dup displaces whatever pre-call value the
  field held, un-freed (≤1 per call)**: the callee can't know whether
  that value was heap or a rodata/borrow.

## Owning container fields in container elements (remaining gaps)

The transfer + load deep-copy work landed (store_T/replace_T transfer
container leaves; load_T deep-copies `List` fields; auto-derived `copy`
synthesizes deep copies). Remaining gaps (all bounded to non-`List`
container fields / class/enum element fields):

- **`load_T` deep-copies `List`/`Buffer` fields only** (and, on C,
  payload-copyable enums). A `Map`/`Set` field, a nested mv user struct
  field, or a class-typed field of a container element is still returned
  SHALLOW: the caller's scope-exit destroy frees the slot's shared state
  (double-free). `Map`/`Set` have a hand-written `copy`, but it is EXCLUDED
  from the automatic deep copy (`is_load_deep_copy_container`) because
  composing it from the `load` specialization corrupts the returned struct
  on aarch64 (open — the load sret + `<Map>_copy` interaction). Nested mv
  user structs need a synthesized `copy` story (the auto-derive gate
  `field_copyable` does not yet accept `Buffer`/`Map`/`Set` fields). Same
  for enum-with-data element fields on aarch64 (C handles them).
- **`store_T`/`replace_T` transfer only container leaves** (recursing nested
  structs). Class-typed and enum-with-data fields of the element stay shared;
  for a stamped `mv` donor this is sound (spliced → the slot is sole owner),
  but an UNSTAMPED generic-body donor (the library `List.copy` body's `v`)
  whose teardown destroys a class field can still double-free. Adding
  class/enum payloads to the transfer set would close it.

## Field-scoped borrow invalidation (Valen-style effect precision)

Recorded 2026-10-12, out of the Valen group-borrowing comparison
([docs/GROUP_BORROWING.md](./docs/GROUP_BORROWING.md)). Today ANY `ref self`
method call invalidates ALL live child-group borrows rooted at the receiver's
owner — `invalidate_borrows_of(status, owner)` at
src/check/check_access_node.ts:907, where borrows root only at the ultimate
owner variable name (`borrow_owner_of`, src/check/utils/borrow.ts). A method
that writes only `self.scratch` (an int) still kills a borrow rooted at
`self.data`. Sketch:

1. **Record the owner field each borrow came through.** `borrowed_via?: string`
   on StackValue, stamped alongside `borrowed_from`: field-access borrows get
   the accessed field name; method-return borrows get the terminal field of the
   receiver path (`z.animals.at(i)` → `animals`).
2. **Per-method field effect sets.** A syntactic scan of each method body (no
   checked status needed — mirrors `scan_heap_return_functions`), collecting
   fields the method may displace or free: writes `self.X = …`, mv transfers
   into `self.X`, and MUTATOR CALLS on `self.X` receivers (`self.items.push(…)`
   threatens `items` even though no direct write names it), plus the union of
   effect sets of any `ref self` methods it calls (memoized fixpoint,
   cycle-safe). Value-type fields (ints, fixed arrays) drop out of the set —
   writing an int can't free anything (the Nomen-shaped version of Valen's
   "type-stability exception").
3. **Field-scoped invalidation.** `invalidate_borrows_of(status, owner,
fields?)`: with a set, poison only borrows whose `borrowed_via` is in the
   set (unstamped/unknown → invalidate, conservative). Without a set, current
   behavior. Object-level aliases (no `borrowed_via`) are never touched by
   field effects — they point at the instance itself, which only owner
   reassignment/destroy can displace, and that path is deferred.
4. **Sound fallback keeps it incremental.** Bodies opaque to the scan (calls
   through func values, recursion, spawn captures) get an "all fields" effect
   set — identical to today's behavior.
5. **Wiring.** The effect set is computed per callee at the single call site
   (check_access_node.ts:907). Audit whether the mv-field-assignment
   invalidation paths need the same field-scoping; view borrows' eager
   invalidation on reassignment stays as-is (the buffer actually frees).

Tests: `poke`-writes-`scratch` keeps a `data`-rooted borrow; `push`
invalidates `items`-rooted element borrows but not sibling-field borrows;
transitive effects (a `ref self` method calling another); opaque-body
fallback; all existing invalidation tests unchanged.

## Residual Buffer holes

The raw slot primitives are now `internal` (library-internal visibility
landed), so these are only reachable from System containers — which use
`store_T` on fresh slots and `replace_T` to overwrite and are balanced:

1. **`store`'s fresh-slot contract is load-bearing.** Removing `store` and
   routing every caller to `replace` broke the load→modify→store
   round-trip uses (`JsonTree.set_kind`/`set_child`/…): `load` returns a
   shallow (aliasing) copy for mv structs, and `replace` frees the
   displaced value _before_ copying, so the aliased copy dangles. Closing
   the remaining leak (a `store` on an occupied, non-aliasing slot) needs
   per-element reclaim in the mv specializations while preserving that
   guard.
2. **`alloc` discarding:** `alloc(n)` sets cap exactly `n`; `grow(n)` rounds
   up. Callers rely on the exact cap. Reclaiming the old slab inside
   `alloc` while keeping the exact cap needs per-element destroy (mv
   `T`).

## Trait-declared field ownership corners

The aarch64 layout/size model includes trait-declared fields
(`layout_fields` in `src/build_aarch64/utils/struct_layout.ts`), and
destroy reclamation frees trait-declared `string` fields on both backends
— see `test/trait_field_defaults.test.ts`. Two ownership corners remain,
both deliberately left:

- **Value-struct trait `string` fields are borrowed rodata.** The ctor
  seeds a trait string default RAW (no strdup, mirroring the C backend),
  and the destroy excludes value-struct trait fields so it never frees
  rodata. A later heap assignment into such a field is therefore not
  reclaimed (leak). The crash-class half is closed: a trait-typed
  reassignment frees the displaced value only when EVERY known conformer
  owns its trait field (a mixed set once freed the non-mv conformer's
  rodata seed — an invalid free). The remaining refinement is
  runtime-conformer-aware frees (a vtable compare per owning conformer at
  the write), which would also let mixed-set writes dup only for owning
  instances.
- **Fixed-array ELEMENT trait fields**: `emit_destroy_for_array_elem`
  (aarch64) walks `struct.fields` only and gates on an explicit `#destroy`,
  so a fixed-size array FIELD whose element struct carries trait-declared
  owned fields (and no explicit destroy) is not recursively destroyed. The
  shape is unreachable without `unsafe` (fixed `T[N]` struct fields need
  pointer indexing), so it stays a recorded corner; the nested-STRUCT
  variant is closed (a nested conformer's trait-declared fields now make
  the enclosing destroy walk fire, and custom `#init`s seed trait
  defaults).

## Custom `#init` computed seeds: residual bounded corners

The computed-seed override-displacement analysis landed (both backends;
covered by test/override_ctor_displaced.test.ts). Deliberately left
(bounded leak, never an invalid free — verified still leaking
2026-10-09):

- A conditional computed write over a RODATA default: the no-write path
  leaves the literal in the field, so the field stays unrecorded and the
  write path's seed leaks (≤1). A heap default closes it (both paths hold
  heap → recorded).
- Later `#init` writes to the same field displace the previous write's
  value un-freed when it was heap (the init cannot know the displaced
  value's ownership; the first write's default reclaim is the only static
  fact).

## Kill-trampoline teardown for parked fibers (deferred)

Nursery cancel/timeout wakes a parked fiber and the fiber exits
cooperatively by polling `Task.current_cancelled()` at its checkpoints —
or by `Channel.receive` returning the zero value once cancelled. The
bounded-slice wait and the unconditional join-before-exit landed (see
`test/kill_kick.test.ts`).

What remains: a task that NEVER observes cancellation (one long
unobservable raw sleep, a tight CAS loop, a raw blocking FFI call) now
hangs its nursery's join instead of corrupting memory — the
join-before-exit contract holds, liveness doesn't. The full fix is the
kill trampoline: push a teardown frame onto the parked stack, switch to
it, and let normal scope-exit `#destroy` unwinding run every live frame.
That needs forced stack unwinding of suspended frames (or a longjmp-style
teardown entry), a substantial runtime feature; until then cancellation
is cooperative only.

## Advisory parking-lint content (remaining)

The lint is scoped to fiber-reachable code; the deadlock-design
discussion settled its content:

- Baseline: flag park-capable calls (`Task.result`/`result_uint64`/`wait`,
  `Channel.receive`/`receive_string`, `Mutex.lock`, `wait_for_io`-backed
  primitives) transitively reachable from a `Fiber(...).start()` — shows
  the wait edges without judging them.
- Channel-end advisory (uses existing move/borrow tracking): when a
  receive-end flows into a nursery and no send on that channel is
  reachable inside the block, note "waits on a producer outside this
  block" — the join-before-communicate shape, as a hint.
- Explicitly advisory, never a rule: produce-inside /
  consume-after-the-brace must keep compiling, and timeout/race recovery
  choreography relies on cross-block sends.

## Phase 4 remainder

8 KB initial stacks + growth (guard page + SIGSEGV handler vs
compiler-inserted stack-limit checks), `await` sugar, an io_uring runtime,
the parking lint (above), plus the Phase 3 leftover: the 10k-connection
acceptance run (N = 64 is the tested ceiling). ASYNC.md's "Roadmap" is
the source of truth.

## Opaque-closure spawn result leaks the original string (closure form)

The function-value spawn construction (`Thread(() => …)` / `Fiber(() => …)`,
or a moved func-typed local, or a named function) duplicates and leaks a
`string` result when the closure is opaque to the compiler. For a capturing
lambda literal the result is alias-checked against the captured strings and
only `strdup`'d when it aliases the env (balanced, no leak); for a
capture-free literal it transfers as-is. An opaque closure (a moved
func-typed local, or a named function materialized as a thunk) instead gets
`nomen_str_dup(_r)` with the original leaked — "leak-never-dangle", bounded
at one allocation per run (`src/build_c/build_magic_ctor.ts`,
`src/build_aarch64/build_magic_ctor.ts`).

The direct-call form (`Thread(fn(args))`) is unaffected: its trampoline
calls the function and stores the result with no aliasing question.
Posture decided in docs/ASYNC.md ("Design decisions"): keep the documented
leak for now. Possible fixes if it matters: extend the closure descriptor
ABI to carry result ownership so the adapter can transfer vs duplicate
exactly, or reject an opaque string-returning closure with a diagnostic
(forcing a lambda literal whose captures the compiler can see).

## `Fiber.start_on(buf)` runs on a heap stack (spec/impl gap; last name-keyed launch site)

The async migration made `Thread.start`/`.detach` and `Fiber.start`
ordinary library methods, but `Fiber.start_on(buf)` remains special-cased:
the checker validates the compile-time stack buffer (`check_spawn_start_on`
— fixed-size array, ≥ 16 KB) and then REWRITES the access to the ordinary
`Fiber.start` (`src/check/check_access_node.ts` — the
`target_type.name === "Fiber" && node.name === "start_on"` arm). The
fiber therefore runs on a HEAP stack, never the caller's buffer — on both
backends, and it always did. The SPEC's "caller-provided fixed-size array
stack" sentence (SPEC.md, Fiber section) is the documented-but-untrue bit.

Two things are missing to make it real:

1. **Storage for `T[N]` no-init declarations.** `var uint64[2048] stack_buf`
   lowers to an UNINITIALIZED `T*` element pointer in the C backend
   (`build_declaration_node`: a stack C array requires a literal/range
   initializer) — there is no buffer to hand the fiber. Both backends need
   a no-init `T[N]` form that materializes the caller's storage (or an
   explicit zero-init/`uninit T[N]` spelling).

2. **A method-body representation of the buffer's compile-time byte size.**
   `Fiber.start_on`'s raw body needs `len * sizeof(elem)` (strings are the
   16-byte fat pair, everything else one word). A method signature has no
   way to accept "any fixed array, byte size known at compile time": no
   sized-array parameter form, and no `T_SIZE`-style substitution for a
   parameter's element size.

When both exist: declare `start_on` as a real `Fiber` method over the
runtime seam (mirroring `Thread.start`'s body), delete the checker
rewrite, and the last name-keyed launch dispatch is gone. It can stay
Fiber-specific (embedded/no-heap path); `Spawnable<T>`'s surface remains
`start`/`detach`.

## aarch64 code-quality notes

### `--release` emitter cleanup

The release pipeline's four text passes only ever fire on the emitters'
one per-function `b .return_X` before the (always adjacent) return label.
Stop emitting that branch when the return label immediately follows
(per-function tail emission, or a single post-pass in
build_function_node): deletes the branches in debug builds too, makes
`--release` a true no-op on aarch64, and lets the branch-to-next pass
converge instantly.

### Pure-Nomen 64-bit arithmetic emits looser code than a raw `#arch` body

`Random.next` (splitmix64) is pure Nomen — verified bit-identical on both
backends — but the aarch64 output is ~40 instructions where the
hand-written body was ~14. The gaps, if this ever becomes hot:

1. **Constant materialization.** Each 64-bit literal becomes `movz` +
   three `movk` (4 instructions); the raw body used one `ldr xN, =CONST`
   from the literal pool (`asm_remat`/`asm_coalesce` do not fold `const
uint64` locals here).
2. **Field-value forwarding.** `self.state = …; var z = self.state` stores
   and then reloads the field instead of keeping the value in a register.
3. **Immediate shift counts.** `z >> 30` does `mov x0, #30; lsr x0, x12,
x0` rather than an immediate `lsr x2, x0, #30`.

Two ways to close: restore the raw `#arch` bodies (git history has them),
or teach the aarch64 ASM optimizer the three folds (benefiting all
pure-Nomen 64-bit arithmetic).

### Post-processing passes dominate large builds

On a synthetic 1609-function corpus, ~15 s of an ~18.8 s build phase is
the UNCONDITIONAL asm post-processing pipeline, all linear but with heavy
per-line regex work (the three profiled hotspots were cheapened
2026-10-01, byte-identical outputs, ~30% off the pipeline). If
large-program builds need more headroom, the remaining cost is each
pass's own per-line analysis — a shared `label/directive/alias/code` memo
keyed on the trimmed line is the next candidate.

## `last_result_is_heap` is side-channel state (structural rewrite optional)

CLOSED as a bug class (2026-10-03): every consumer now enforces
reset-first, and build_block_node clears the flag at every statement
boundary. Remaining (deliberate): the flag itself is still side-channel
state rather than an ownership value threaded through the RHS emitters
(`{ heap: boolean }` returns). That rewrite touches every emitter and the
NIR seam for no correctness gain under the enforced contract — worth it
only if the flag grows more consumers or the bounded-leak default becomes
a measured problem.

## Tranche-3 shelved pieces (measured, not shipped)

ASM_PLAN_5 tranche 3 landed the ext-borrow machinery + hardenings; these
were tried in the same session and reverted (full bench matrix
byte-identical; pidigits baseline-relative arc 1.89× → ~1.53× vs C `-O2`):

- **x15 reservation**: withholding x15 function-wide whenever any loop
  holds a pinnable accessor cost +0.02 on pidigits and LOST the D6
  x23/x24 pins. Verdict: pool-shift cost exceeds pin benefit at this
  shape; revisit only with a per-function proven trade.
- **Nested-loop pin refusal**: skipping pins for loops containing nested
  loops — unmeasured benefit, shelved to keep the tranche codegen-neutral.
- **collect_var_refs coverage** (method-arg params under `access_func`,
  if/match/switch branch fields, ref/mov address-taken): broad promotion
  effects need their own tranche with isolated timing receipts. (The
  coupled `_param_N`/`_vn_N` promotion exclusion SHIPPED — neutral.)
- **Promotion site-sharing**: sharing loop claims onto decl-site regs
  under the adjacency proof — needs an isolated receipt (the D-arm
  collision it targets refuses by construction, but no bench proves the
  gain).
- **Session-2 forensics**: the preheader `_vn = wd_off + u_len + 1` hoist
  IS firing in div_to's D4 loops; the in-body index chains still read
  u_len from its slot and rebuild. Whether the recorded eval+argN splice
  survives to the eval dispatch for these statements is the open
  question — rebuild the repro from the test harness (check_output's
  audit path), not a hand-written mini.

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

## json-serde run-time regression in 0.7.0 (string-ownership copies)

Head-to-head against `nomen-lang@0.6.13` (2026-10-10, identical
`bench/nomen/json-serde.nm`, byte-for-byte outputs match): best-of-3 run
time went 59→95ms on aarch64 (+61%) and 30→61ms on the C backend (+103%).
The generated C is call-count identical for malloc/memcpy/realloc but adds
~12 `nomen_str_dup(` call sites, 2 `string_copy(`, and 4 extra
`JsonNode_destroy(` calls — the D3 string-ownership lowerings (field reads
and returns now `.copy()`, uniform-heap normalization) landing in the Json
parser's hot paths, with `List`/`Map` now `mv struct`s on top. Everything
else in the bench suite is flat (±5%); binarytrees/merkletrees +19–36% is
the class→`mv struct`+`Box` tree idiom (one alloc before, alloc + struct
memcpy per child now), not codegen. Worth a pass over the Json parse path
to identify which lowered reads can stay borrows (e.g. view-returning
field reads where the caller immediately re-copies or hashes).

## Endgame: compiler magic keyed on marker traits (the `#spawn` retirement)

`#spawn` began as a one-time construction hook (Thread/Fiber) and `#weak`
followed it; the family is now cited as the extension point, and Box's
representation magic is NAME-keyed (`stamp_box_wrapper_representation`
matches `name === "Box"` at src/check/check_block_node.ts — the one place
`is_class` is stamped — with `is_box_type` gating ~15 call sites). This
section records the converged endgame (design discussion 2026-10-11) so
the next "add a hook" request lands here instead of growing `#`-members.

### The design: one mechanism — traits — carrying three axes

- **Functions** → vtable dispatch (operation lowering; the `Enumerable`
  tier). First candidate to formalize: `for x of y` currently keys on
  member PRESENCE (`length` + `.at`, see the element-iteration section
  above) — the C#-GetAwaiter-style duck typing. Making it require declared
  `Enumerable<T>` conformance converts it into a visible, specable
  trigger. All future operation magic (hashing, formatting, serde) lands
  here: a new operation trait with a member contract, a deliberate act.
- **Fields** → layout participation. Already shipped for conformers
  (`layout_fields` in src/build_aarch64/utils/struct_layout.ts,
  test/trait_field_defaults.test.ts): a trait-declared field is inherited
  into the conformer's layout, ctor-seeded, destroy-reclaimed. This is
  also the shape-validation story: a marker that declares `mv T __value`
  makes the trait BE the representation contract — conformance checks the
  shape AT the declaration site (a compile error where you write
  `: HeapWrapper<T>`, never silent misbehavior at a use site), and the
  declared field is the same offset information the B5 field-dispatch
  design needs (see "Trait-typed FIELDS on mv structs" above).
- **Nothing** → pure semantic marker that TRIGGERS a compiler contract.
  Markers trigger, they don't encode — the semantics live in the compiler
  and conformance is the opt-in (Rust's `Copy`/`Send`/`Sized` are the
  precedent that this scales to representation).

This supersedes the "representation attributes" idea (which waited on the
comptime attribute system — docs/COMPTIME_PLAN_2.md D1 punts attribute
syntax): marker traits use the existing conformance clause, so there is no
syntax prerequisite. It also absorbs the C# analogy correctly: interface
magic in C# lowers OPERATIONS to member calls (IEnumerable/foreach),
while representation (Span) stays compiler-known — triggering markers
unify both without a second mechanism.

### Naming

Markers are traits: PascalCase. The suffix is a documented signal:

- `-able` = operation/participation magic (member contracts the compiler
  lowers to): `Enumerable`, `Hashable`, `Equatable` — and `Spawnable<T>`,
  which already exists with `start`/`detach` and would fold the async
  construction form into its existing contract.
- Plain noun/adjective = representation marker, usually memberless:
  `HeapWrapper` (Box), `RegistryHandle` (WeakHandle).

`-able` predicates capability; representation markers predicate identity
(a WeakHandle isn't "handleable", it IS a handle) — Rust's markers are
bare adjectives/nouns for the same reason. Marker names live in the type
namespace (no collision with the runtime `Task` type) and are reserved in
core with the same shadow-proofing `Box` gets at parse today.

### Work items (all extensions of existing machinery)

1. Required trait fields: today a trait field means provided-with-default
   (inherited, ctor-seeded). Markers need required-no-default — "the
   conformer must declare `__value` itself" — a small checker rule on the
   existing feature.
2. Generic markers: field conformance under T-substitution. Generic traits
   already clone with substitution for functions; ride the same machinery.
3. Reserved marker set: declared in core; the checker rejects shadowing.

`is_box_type` keeps its exact semantics — the stamp function checks marker
conformance instead of the name, and every downstream call site is
unchanged. A core wrapper conforming to `HeapWrapper` then gets the whole
family for free, including the construct-in-place Box elision (landed
2026-10-11: `Box<T>(T(...))` builds the wrapped value directly into the
malloc'd slot, both backends).

### `#spawn`/`#weak` demotion path

The construction special forms become implementation details of declared
strategies — `: Spawnable` (async) and `: RegistryHandle` (weak) — with a
deprecation cycle for the user-Awaitable `#spawn` spelling. INTERIM
guardrail until this lands: freeze the `#`-member namespace (the checker
rejects unknown `#foo` members as reserved) so the family stops growing.

## Bugs surfaced by the allmark 0.7.0 port (2026-10-11)

The allmark `nomen/` port migrated to 0.7.0 (classes → `mv struct`,
`move` → `mv`, else-outside-switch, `Arena<Box<MarkdownNode>>`). All 1980
tests pass and benchmarks are flat-to-faster vs 0.6.13. Three compiler
bugs were found on the way; two are fixed (`.bumpy/swift-deep-maple.md` —
return-save `stp`/`ldp` beyond the +504 scaled-offset range crashed the
assembler on large frames; and the sret-returned local `mv struct`
scope-exit segfault, see git history), and one is open, with a verified
repro below.
(The first-found checker hole — by-value `mv struct` params silently
aliasing into a double free — is fixed; see git history for the
`borrowed_param_transfer_error` checker rule.) All were debugged on
macOS/arm64 with the audit runtime.

### 1. aarch64: rvalue string temps passed to `ref self` methods are never freed — pre-existing

On aarch64 (C backend is clean), a fresh string call-result handed to a
mutating method through an arena-fetched `Box` leaks its malloc. Present in
0.6.13 as well (verified with the same repro on both compilers), so not a
0.7.0 regression — recording it because the port's audit runs surface it on
every parse: one 2-byte leak per inline text chunk.

Repro (`nomen run --audit`, aarch64: `LEAK: 3`, C backend: clean; 0.6.13
leaks identically):

```nomen
import System
import parse
import render
import rulesets
import transform
import types
import utils

pub func main = (Init init) {
	const result = parse("a b", core())
	Console.write("done\n")
}
```

(3 chunks — `"a"`, `" "`, `"b"` — each a `state.src.substring(...)` rvalue
fed to `MarkdownNode.append_content` inside `textRule`.) Attempted
minimizations (fetch-from-arena + `append_content(substring(...))` loops,
field-of-ref-param receivers, new_text+append+length in a loop) all run
audit-clean, so the trigger involves more of the real call shape — likely
the interprocedural temp-free analysis (`string_return_analysis` /
`scan_borrow_returns`) missing this path. Tracing the aarch64 vs C
NOMEN_AUDIT_TRACE streams shows exactly three missing `FREE 2` lines.
