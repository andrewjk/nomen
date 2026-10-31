# Follow-ups

Recorded issues that were deliberately not fixed inline (out of scope for the
task that surfaced them). Each entry: what was seen, where, and any context
needed to pick it up later.

## Enum match on a call scrutinee SIGBUSes on aarch64 (pre-existing, surfaced by the variable-mode bench)

Recorded 2026-10-30 while landing PERF_PLAN item 13 (variable-mode enums,
`bench/nomen/enum_variable_mode.nm`). Reproduced at main@7ecb5593 with the
pre-change compiler — the bench deliberately avoids the shapes:

- **`match <call>() { … }` / `match l.pop() { … }` on a multi-case data enum
  SIGBUSes on aarch64.** `while l.length > 0 { match l.pop() { case .small(v)
{ … } } else { … } }` over `List<Item>` (`Item { case missing; case small(int
id); case big(int id, int a, int b) }`) dies at n = 1 (exit 138). A plain
  variable scrutinee (`var it = l.pop(); match it`) and an all-cases arm list
  crash the same way; the same program on the C backend runs. `at_or_panic`
  as the scrutinee is fine at n = 1000 on aarch64, so the trigger is the
  pop/owning-temp path specifically — the match hoists the call result into a
  temp blob (`scrutinee_is_temp`), and the pop result's slot handling
  disagrees with the hoist. A single-case case-mono (`List<Item.small>`)
  works, which is how the variable-mode bench and tests cover the same
  shapes.
- **`List<mv-enum>.at(i)` fails contract verification even with a literal
  index** ("Parameter constraint cannot be verified: i >= 0 && i <
  self.length") — `at_or_panic` verifies fine and is the workaround the
  tests use. Reproduced unchanged at HEAD.

## Value-struct copy-assignment corners (pre-existing, surfaced by the struct last-use tests)

Recorded 2026-10-29 while landing PERF_PLAN item 3 (move-on-last-use for
structs, `test/struct_last_use_move.test.ts`). Both reproduce on
main@66f82e91 unchanged — the new tests deliberately refuse to rewrite these
shapes, so they pin guards, not the bugs:

- **`p = p.copy()` (self-assignment) is a use-after-free.** The C backend
  frees the displaced value's fields (`free(p.name.ptr)`) BEFORE the copy
  call reads them — `Pair_copy(&p)` strdups the just-freed `p.name`. The
  program prints nothing / crashes (audit mode: stale free). The aarch64
  backend has the same ordering (displaced free, then the copy reads the
  source slot). A same-variable RHS needs the `s = s + "x"` treatment:
  compute the RHS into a temp before the displaced free.
- **`p2 = p1.copy()` with a displaced old `p2` leaks one allocation** (audit
  run: `LEAK: 1 allocation(s)`; `var p2 = Pair(); p2 = p1.copy()` with a
  later read of `p1`). The declared-then-reassigned shape loses the seed's
  heap string field somewhere in the displaced-value reclaim + fresh-copy
  store sequence. The declare form (`var p2 = p1.copy()`) is leak-clean, and
  the move-on-last-use transfer of the same shape is leak-clean too — the
  loss is specific to the copy-into-displaced-slot path.

## Struct-plan residuals

(The plan documents are consolidated in [`docs/STRUCTS.md`](./docs/STRUCTS.md);
the "STRUCT_PLAN_3" labels below are its section names.)

The class retirement (Phase R) and the struct/move refactor (Phases B/D)
have landed: `class` is retired with a dedicated parse error, the Copyable
verifier runs over declared ownership, `string` is a declared mv type,
and the mv-struct string-field lowerings are uniform-heap on both
backends. What remains:

### Test-corpus skips that name live gaps

Each skip masks a real post-R/B1/D3 gap (verified still failing
2026-10-09):

- **`operations` (2) + `interpolate_string` (1)**: compile-time
  division/modulo-by-zero detection — a language-feature ask ("TODO: This
  needs runtime protection"), not a backend bug.

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

## Field-scoped borrow invalidation (Valen-style effect precision)

Recorded 2026-10-12, out of the Valen group-borrowing comparison
([docs/GROUP_BORROWING.md](./docs/GROUP_BORROWING.md)). **Superseded design
(2026-10-23)**: the body-scan mechanism sketched below was rejected
(reasoning burden, scan/fixpoint cost) in favor of signature-declared effect
sets — `ref self mutates data, cache` — verified against the body at the
definition. The plumbing half of the sketch (`borrowed_via`, field-scoped
`invalidate_borrows_of`) survives unchanged. Full design, syntax decisions,
staging, and tests: [`docs/FIELD_EFFECTS.md`](./docs/FIELD_EFFECTS.md).

Today ANY `ref self`
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

Data-structure note (2026-10-22, from Ante's places-over-lifetimes post —
see the GROUP_BORROWING.md addendum): key borrows as place-sets — (owner
root, field path) pairs — rather than bare field-name strings. The match at
invalidation time should compare paths (Ante's unstable-place checker works
this way), so a future place-carrying container (`at_ref` returning
`(p!, container!)` element references — the unstable-place fix for the
`step` shortfall) extends this structure instead of reworking it.
`borrowed_via` can stay the serialized string; the path comparison is what
matters.

Tests: `poke`-writes-`scratch` keeps a `data`-rooted borrow; `push`
invalidates `items`-rooted element borrows but not sibling-field borrows;
transitive effects (a `ref self` method calling another); opaque-body
fallback; all existing invalidation tests unchanged.

## Buffer `modify_T` displaced containers/closures leak

The mv `modify_T` specialization identity-frees displaced STRING leaves
but nothing else — a modify on an element holding containers, a `Box`,
a class field, a closure descriptor, or an enum payload leaks the
displaced state (`store_T` had the same hole; its guarded reclaim
landed 2026-10-15). The store_T-style pass is NOT sound here: the fn
receives a BYTE COPY of the slot whose container words alias the slot's
slabs, and an in-place mutation through the copy (`h.items.push(x)` →
`grow` → `realloc`) leaves the slot's data pointer dangling-but-
different from the returned value — indistinguishable from an intact
non-aliased slab, so the identity guard would free an already-
realloc-released block. (The string leaves stay safe: a fn mutating the
copy's string field repairs the copy's own field through its write
path, so the identity compare sees a consistent state.) A sound fix is
an ABI change — pass `modify` a deep copy (the `load` treatment) and
destroy the copy after the call — which changes the primitive's
in-place economics; only worth it if a System container needs
mv-container modify. Both backends' modify emitters carry pointers to
this note.

## Trait-declared field ownership corners

The aarch64 layout/size model includes trait-declared fields
(`layout_fields` in `src/build_aarch64/utils/struct_layout.ts`), and
destroy reclamation frees trait-declared `string` fields on both backends
— see `test/trait_field_defaults.test.ts`. One ownership corner remains,
deliberately left:

- **Runtime-conformer-aware frees** (a vtable compare per owning
  conformer at the write): a trait-typed reassignment today frees the
  displaced value only when EVERY known conformer owns its trait field;
  per-conformer knowledge would let mixed-set writes dup/free only for
  owning instances.

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
- An aarch64_use_c FREE function is emitted into the C companion with an
  `__asm__("name")` label — and clang rejects a label applied after first
  use, so every `extern` declaration of it (e.g. a walker in another file's
  `#scope: file` block) must carry the SAME `__asm__` label. Externs must
  also spell parameters with the companion's `nm_` typedef names
  (`nm_Container`, `nm__Tuple_int_int`, …) — `struct Container *` is a
  different (incomplete) type there and conflicts. Pure-Nomen free
  functions are asm-emitted instead (no companion definition, no label);
  their externs keep the plain `struct`/`_Tuple` spellings. Live example:
  `nomen_scroll_thunk`/`set_content_size`'s registry/`nomen_scroll_measure`
  in core/System/Controls/{Scrollable,Container}.nm. Related
  hoisting rule: `#scope: file` blocks hoist to the top of the generated
  TU regardless of where the carrier function sits — and the aarch64
  backend only hoists them from GENERATED functions (methods, or free
  functions with bodies); an empty-body free function used purely as a
  file-scope carrier gets skipped on aarch64 (its content never emits —
  put such blocks in a real method, e.g. set_content_size).

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

Update Oct 2026: the Json-ownership half of this landed
(PERF_PLAN item 5) — `JsonTree.take_text`/`get_text_view` removed the
per-node set_text copy + get_text read copy, taking json-serde to −22% /
−12% (C / aarch64, `bench/sample.json 50000`, interleaved medians,
byte-identical outputs). The regression's other cited causes (uniform-heap
field reads/returns in user shapes, `List`/`Map` as `mv struct`s) are
untouched by it.

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

## TextView.set_placeholder relies on AppKit's private KVC placeholder

`core/System/Controls/TextView.nm`, `set_placeholder`: AppKit has no public
NSTextView placeholder API, so the implementation goes through KVC
(`setValue:forKey:@"placeholderString"`). It draws correctly in a live window
on this macOS version, but two caveats:

- `cacheDisplayInRect:` (offscreen rendering, e.g. a screenshot-based test)
  does NOT draw the placeholder — the value round-trips through KVC but stays
  invisible. So placeholder rendering cannot be verified offscreen; only in a
  real window.
- Being private API surface, a future macOS could drop it entirely.

If that happens, the fallback is an NSTextField hint overlaid on the text
view (subview, pinned to the top edge via autoresizing mask, hidden through a
runtime-built `textDidChange:` delegate — same pattern as Container's
NomenResizeDelegate), plus an explicit visibility update in `set_text`.

## Generation-checked views for dynamic-removal safety

Dynamic removal (a removed todo's stale view — `demos/todo` deletes
controls at runtime) wants generation-checked views: reuse the
`WeakHandle` registry (pointer + generation slots, destroy bumps) so a
view whose owner is gone is detected at use instead of pointing at freed
state. Split out of the on_click work (2026-10-20).

## Handler desugar: owner-dispatched callbacks (Stages 1–4 landed)

Stages 1–4 are DONE (2026-10-20/21): control-carried
`self.<field>.on_<event>(closure)` — the closure hoists to a hidden method
on the enclosing struct, the site checks into a dispatch arm on a
synthesized `handle_clicks`, and `Window.run` drains the arms before
`frame` with a dispatch-time `ref self` borrow — so handlers reach app
state without capturing anything. Stage 2 opens it to user composites: any
struct the app owns (transitively, down static field paths) is a handler
host, forwarding is synthesized child-first, and `Pagination`'s internals
are off polls. Stage 3 adds the upward tier: composite events
(`on_page_change` + `tick`) call back into the app's synthesized
`run_handler` through a trait-typed `ref` owner borrow — `ref Trait`
params now take conformer borrows (the instance's first word is its
vtable). Stage 4 adds dynamic trees: `List<Row>` fields dispatch per
element through the ELEMENT BORROW (`ref Row row = list.at(i)` — the
sanctioned interior borrow, lowered to the library's `slot_ptr`; a `ptr T`
return is a bare word in x0 on both backends). The window binding list
(`Window.on_click` / `ClickBinding` / `dispatch_clicks`) is retired, and
`was_clicked` is demoted from the documented pattern (it stays as the
low-level ring primitive). Full design, checker rules, staging, and the
alternatives rejected: [`docs/HANDLERS.md`](./docs/HANDLERS.md).

## Guarded non-zero index access can't discharge (`xs.at(1)` under `xs.length > 1`)

Recorded 2026-10-27, while auditing the (since-fixed) core-trust naming
bypass. Memory-SAFE — the unprovable call is a compile error, so this is a
usability gap, not a soundness one.

`xs.at(0)` under `if xs.length > 0` verifies, but `xs.at(1)` under
`if xs.length > 1` (or `>= 2`) does not — the flow-bounds machinery only
discharges index 0 against a strict lower-bound guard. The sanctioned
workarounds: `.pop()`, `.at_or_panic`, a loop, or indexing 0. Fixing the
discharge (literal index `k` proven by a strict `length > k` guard, or
inclusive `length >= k + 1`) would close it; the constraint evaluation
lives in `evaluate_const_condition`
(src/check/utils/evaluate_const_condition.ts).

## System.o prebuild races parallel workers after a core edit

Recorded 2026-10-28. The first `vp test` run after editing `core/**`
rebuilds `test/out/system_lib/**` (globalSetup prebuild) — when that
rebuild overlaps cold workers, 1–27 tests fail spuriously (mix of link
errors and audit-run failures); the NEXT full run is green with zero
changes. Three consecutive post-rebuild runs settled to stable green, so
the failures are a rebuild/worker race, not codegen. Mitigation for a
touched-core session: run the suite once to rebuild, then judge on the
second run — or make the prebuild a hard barrier for worker startup.

## `while cond; { … }` (empty post-statement) fails to parse

Recorded 2026-10-27. `while i < 12; i += 1 { }` (with a post-statement)
and `while cond { }` (without the semicolon) both parse; the
semicolon-with-empty-post form `while items.length > 0; { }` errors with
"Expected {" at the body. The post-statement slot should accept emptiness
(the loop-building code it forced — a dummy `s = s + items.pop()`
restructure — is uglier than the form it replaced). Parser lives in
src/parse (while-loop parsing).

## Orphaned `???`/`!!!` tokenizer symbols

The ziglings test corpus (removed 2026-10-24 — early scaffolding: 56 files
never ran at all, and the 54 that did duplicated coverage the other 500+
test files provide) was the only producer of the emphasis symbols `???` /
`!!!` (`src/tokenize.ts`, where the comment already says "mostly for
ziglings, can be removed if necessary"; also listed in `src/format/join.ts`'s
`NO_SPACE_AFTER`). Nothing else emits them. Deleting the symbols is a small
compiler change (the tokenizer compound list plus the formatter set) with no
functional payoff beyond tidiness, so it was recorded rather than done —
worth folding into the next tokenizer-touching change. Nothing else in the
repo uses `???` as a placeholder.

## Unterminated aarch64 leaf emits rely on a later `ensure_newline`

Recorded 2026-10-29. Several operand emitters leave the code buffer
unterminated and depend on the NEXT emit (or an enclosing
`ensure_newline`) to terminate the line: `emit_immediate`
(src/build_aarch64/build_value_node.ts — `mov`/`movn`/`ldr =` arms) and the
char-literal/int-operand arms in build_operation_node.ts (lines ~906, ~962,
~968, ~1030). This surfaced when the in-place-push ctor tranche put the
call emitter's per-argument x8 re-preset directly after an immediate arg —
`mov x0, #90ldr x8, [x29, #48]`, which the asm reader rejects. The exposed
call site got an `ensure_newline` before the re-preset
(build_function_call_node.ts); the emitters themselves are unchanged, so
any new emit placed after an argument build without its own
newline-ensure can reintroduce the glue. Root fix: terminate inside the
leaf emitters (or make emit_asm always terminate) and drop the
compensating calls.

## Scalar element borrows via `List.at` are blocked by contract verification (pre-existing, surfaced by the Map element borrow)

Recorded 2026-10-29 while landing PERF_PLAN item 4 (borrow-returning reads,
`test/map_get_ptr.test.ts`). The element-borrow rewrite `ref T x =
container.<read>(i)` is element-type-agnostic in the checker, but the scalar
shape only works for containers whose read has NO parameter contract:
`ref int v = list.at(0)` fails with "Parameter constraint cannot be
verified: i >= 0 && i < self.length" (the verifier cannot prove `at`'s
bounds contract at the rewrite site, even right after a `push`), while
`ref int v = map.get_or_panic(k)` checks clean — `get_or_panic` has no
parameter contract (it traps internally). Consequence: scalar element
borrows are Map-only today. Fix shape: teach the bounds verifier to use the
rewrite's own length facts (`push` → `length`), or give `at` a
contract-free `at_ptr`-style primitive to rewrite to.

## `join` inlines stray `.nm` files from the OS temp root during test compiles (robustness trap, no compiler bug)

Recorded 2026-10-29 after a false alarm: six suite failures
(`leak_hygiene`, `test_harness`, `extension_source_map`) that looked
pre-existing were caused by scratch `.nm` files left in `$TMPDIR` while
debugging. `run_test_file` (cli/src/test.ts) mkdtemps under the OS temp
root, and `join`'s `gather_module_parent` (src/join.ts) scans that parent
for `.nm` siblings — a `*.test.nm` entry carries no `func main` at join
time, so `entry_is_program` is false and main-bearing neighbors are NOT
skipped: every scratch file gets inlined, producing confusing
"Function already declared: main" errors whose line numbers point deep
into the joined source (plus unrelated constraint errors from the inlined
code). Fix directions: mkdtemp under a nomen-owned root instead of the
temp root, skip parent gathering for test compiles (they are standalone),
or treat a harness-bearing test entry as a program for the skip checks.
