# Follow-ups

Recorded issues that were deliberately not fixed inline (out of scope for the
task that surfaced them). Each entry: what was seen, where, and any context
needed to pick it up later.

## Struct-plan residuals

(The plan documents are consolidated in [`docs/STRUCTS.md`](./docs/STRUCTS.md);
the "STRUCT_PLAN_3" labels below are its section names.)

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

STRUCT_PLAN_3 Phase N's deferred remainder:

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

`for x of some_list` desugars to element iteration for `Array<T>`, `List<T>`,
and `StableList<T>`. The Enumerable conformers (`LinkedList<T>`/`Tree<T>`/
`Graph<T>`) took a different, broken path until 2026-11-18: the checker's
Enumerable arm admitted them (index iteration by design), but their
`length` is a METHOD — no compile-time length node on the type — so the C
backend crashed building the loop (`build_node` on the missing node) and
the aarch64 binary silently iterated ZERO times. They are now rejected at
check (`'for x of' over <T> is not supported yet`, pinned in
test/enumerable_forof_gate.test.ts). What keeps them rejected:

- Return-contract linkage from `length()` to the count field is still
  missing (verified failing 2026-11-18: a `0..ll.length()` RANGE does not
  discharge `at`'s count contract). Count tracking itself landed
  2026-11-09 (fresh = 0, `add` = +1, link setters preserve; `.count` facts
  discharge `at`), so the linkage is the one missing piece — it unlocks
  both the explicit `0..length()` shape and a lowerable Enumerable arm.
- `Graph<T>` additionally has only the `Enumerable` default `length`
  (returns 0) — it needs a real length before any iteration can mean
  anything.
- `Map`/`Set`/`Buffer` are cleanly rejected (no `.at(i)` element semantics
  to desugar to; they don't conform to `Enumerable`).

Also still open from the same area: `for ref x of list` is rejected with
a dedicated error (List `set` takes `mv T`, so the array writeback
shape doesn't transfer — needs its own design).

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
or by `Channel.receive` returning the zero value once cancelled.

A task that NEVER observes cancellation (one long
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
`Fiber.start`, dropping the buffer argument (the checker's
`target_type.name === "Fiber" && node.name === "start_on"` arm in
`src/check/check_access_node.ts`). The
fiber therefore runs on a HEAP stack, never the caller's buffer — on both
backends, and it always did. SPEC.md and docs/ASYNC.md now state that
outright (the old "caller-provided fixed-size array stack" description was
corrected 2026-11-25); what remains below is the implementation.

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
comptime attribute system, since shipped — see docs/COMPTIME.md): marker
traits use the existing conformance clause, so there is no syntax
prerequisite. It also absorbs the C# analogy correctly: interface
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

## Bounds-contract discharge residuals (indexed reads and element borrows)

`List.at`'s parameter contract (`i >= 0 && i < self.length`) is verified at
every call site — including the element-borrow rewrite
`ref T x = container.<read>(i)`, which verifies `at`'s bounds contract at
the rewrite site like any call (`element_slot_load`,
src/check/check_declaration_node.ts, recognizes `List.at` and
`Map.get_or_panic` on the slot-container monos — `slot_ptr`/`get_ptr` — so
`ref int v = map.get_or_panic(k)` needs nothing, no parameter contract). The
machinery is `evaluate_const_condition`
(src/check/utils/evaluate_const_condition.ts) and
`apply_list_length_effect` (src/check/utils/flow_bounds.ts). Exact lengths
(`known_length` — for `List` keyed to `.length`; for `LinkedList`/`Tree`
keyed to their `count` field through the same model: a fresh constructor is
0, `add` appends one, the link setters preserve it), guards (including
field-path guards, landed 2026-11-09; `&&` conjuncts and early-return
zero-guards, landed 2026-11-24 — `if n == 0 { return }` proves `n != 0`
after, `if n != 0 { return }` pins `n` to 0, and every conjunct of a
compound guard records), inclusive bounds, singleton-range indices,
negated guards, and length-snapshot aliases discharge it (a `.length`
snapshot is known `>= 0`). What
still needs a guard (or a contract-free spelling — `at_or_panic`/`at_or`/
`at_or_null`,
`get_or_panic`, `pop`):

- **Unknown provenance**: a container from a function return or a parameter
  has no facts UNLESS the signature carries a contract — `ships: ships.length
  > 0` on a parameter (verified at the call site, assumed in the body; the
caller's exact length forwards through the call-site check) or a return
constraint (`out List<T>: out.length > 0`). That is the spelled fact
  > source; without one, guard or use the contract-free read.
- **Globals**: exact tracking is locals-only (`flow_bounds` bails on
  `decl.is_global`) — a global's length can change behind the caller's back
  through any opaque callee. By design: no exact tracking is sound here, so
  a guard before the read is the spelling (the same posture as any storage
  an opaque callee can reach).
- **Guard-fact staleness on unmodeled mutators**: guard-derived bounds on a
  receiver survive `ref self` calls the model doesn't know (only the exact
  fact dies); the length-effect model covers List's
  push/pop/remove_at_or_panic and the count containers' `add` + link
  setters. Closing that means a mutation-precision pass
  (refine-vs-invalidate per callee effect) — worth doing only with concrete
  blocked shapes.
- **`StableList` is outside the length model**: its `at`/`set`/`truncate`
  contracts (`i < self.length`, `n <= self.length`) discharge only from
  guard/range facts — a literal after N pushes ("push a, push b,
  truncate(1)") cannot be proven, because `is_list_type_name` /
  `apply_list_length_effect` cover `List` and the count containers, not
  `StableList` (fresh = 0, push = +1, truncate(n) = exactly n would be the
  mirror). Callers guard today (`if xs.length > 1 { xs.truncate(1) }`);
  extend the model with the first concrete churn complaint, as with the
  scalar-`set` exemption above.

## Mutable-in-Immutable residuals (the syntax-gated remainder)

The contract half of Valen's Mutable-in-Immutable shipped piecemeal as the
declared-effects machinery: `{ entities }` on a ref param IS "may displace
`entities` and nothing else", body-verified; the aliasing relaxation
(disjoint declared sets) is the call-site distinctness; place-scoped List
slot writes are element-level mutation-without-displacement for modeled
calls. What remains is gated, recorded so the next request lands here:

- **Element-place declared effects** (`{ entities[i] }`-style): letting a
  signature promise in-place element writes without displacing the field,
  so wrapper methods over `set` pass place precision through to callers.
  The sound floor today is rule 2 as-is — any mutator call on a `self.X`
  receiver requires `X` in the set — because a wrapper declaring less would
  let callers' element borrows survive its internal slot displacement
  (unsound for mv-element lists). Needs signature surface (new syntax).
- **Scalar-element `set` exemption from rule 2**: a modeled `set` on a
  scalar-element list (`List<int>`) writes a slot that cannot dangle
  anything (the type-stability exception, type-derived from the
  signature's element type), so rule 2 could exempt it and shave annotation
  churn for scalar-state methods. Sound but type-dependent set semantics;
  do it with the first concrete churn complaint.
- **The noalias harvest**: disjoint-set aliased params prove may-write
  disjointness an optimizer could exploit — but the C backend's `restrict`
  is per-pointer (all-or-nothing), not per-field-disjoint, and aarch64 has
  no per-instruction aliasing hints. Parked until a backend that can
  express it exists.

## Context measurement hazard: agent/background shells are not the interactive baseline

Recorded 2026-11-03 (full story: docs/scratch/ALLOCATOR_PLAN.md). The same
binaries measure consistently slower — ~25-40% on clock-bound code — when
run from agent-spawned shells vs an interactive terminal on this fanless M2
Air, varying with machine state, and the penalty falls specifically on
OS-memory-service-heavy allocation paths (page-allocator churn, libc
malloc/free churn); memory-reusing workloads and pure compute are
context-equal (verified with a spin probe: ~2.7s in both contexts). An A/B run
entirely inside an agent shell can therefore turn a neutral change into a
phantom "Large" win if one side sits on the clock-bound side of the line.
This produced a false −22%/−31% "Large" receipt for the allocator attempt
(reverted; the implementation is preserved on branch `allocator-eager`).
Rules of thumb:

- Measure performance from an interactive terminal, or verify an
  agent-context measurement with the same run from a terminal.
- Bracket A/Bs with a context-stable control row (Go binarytrees matched to
  the millisecond across contexts here; it served as the canary).
- A workload whose interactive-vs-agent ratio is ~1 is latency-bound; far
  from 1 is clock-bound. That ratio is itself a useful diagnostic (see
  ALLOCATOR_PLAN.md).
- The QoS mechanism was tested and REFUTED: a `pthread_get_qos_class_np`
  probe reports USER_INTERACTIVE (the highest class) for agent-shell
  processes — the gap is not a QoS/E-core placement effect. Exact
  attribution (P-core contention with the desktop session's load, or
  sustained-load frequency state on a fanless Air) needs `sudo powermetrics`.

## JS backend: strings are UTF-16 code units, Nomen strings are UTF-8 bytes

Recorded 2026-11-10. `src/build_js` maps a Nomen `string` onto a JS string,
so `s.length` counts UTF-16 code units while the C/aarch64 backends count
bytes. ASCII agrees; `"héllo".length` is 5 in JS and 6 natively, and astral
characters (emoji) are 2 units in JS vs 4 bytes natively. `Text.Utf8.encode`
/ `decode_at` / `char_count` are natively mapped onto the JS model
(`String.fromCodePoint`, `codePointAt`, `[...s].length`), so they are
self-consistent with the rest of the JS backend but do NOT produce the same
byte sequences as native. Any other byte-oriented library code that builds a
string one `char` at a time from byte values (0xC0 | … style) will produce a
different string on JS. Modeling strings as `Uint8Array` would fix parity at
the cost of making every JS-facing operation awkward; decide before the JS
backend is treated as byte-compatible with the native backends.

## JS backend: Buffer views and raw slab protocols

Recorded 2026-11-11. `Buffer<T>`/`ClassBuffer<T>` map onto JS arrays (capacity =
array length), which is enough to run the containers built on them
(`LinkedList`, `Graph`, `Tree`, `Arena`, `StableList`, `JsonTree`, `BigInt`).
Two native-only shapes are deliberately not mapped:

- `Buffer.slice` returns a JS array COPY, not a `view T` borrow — a write
  through the slice does not reach the source buffer. `StableList` is modelled
  natively (its public methods never expose a `Buffer` view to user code), so
  the JSON pool is unaffected.
- The raw slab protocols — `Buffer.init_view` / `clear_view` /
  `store_in_slab` / `slot_ptr` — cannot be expressed when the "slab" is a
  `uint64` pointer (`malloc` has no JS analogue). Library code that uses them
  reaches the warning-stub path (`js backend: skipping unavailable feature`).
  `StableList`'s chunked bodies are bypassed by its native array mapping.

Uninitialized grown slots hold `undefined` rather than the native all-zero
bytes; container code stores before it loads, so this only shows up in code
that reads inside `cap` without writing first.

## JS backend: concurrency is a synchronous fallback

Recorded 2026-11-11. The JS backend has no scheduler, so concurrency runs
synchronously rather than being skipped:

- `async { ... }` runs inline; `Thread(...)`/`Fiber(...)` store a thunk and
  `.start()` runs it to completion, returning a finished `Task`. `.detach()`
  also runs it immediately, so a process-lifetime daemon loop never returns
  (the site's 5-second watchdog stops it). The native form returns from
  `detach` while the daemon lives on.
- `Channel.receive` does not block: it returns the zero value when the queue
  is empty, so producer/consumer choreography that relies on blocking changes
  shape. `Mutex.lock`/`unlock` are no-ops and `Atomic` is single-threaded.
- A nursery's `timeout` and `mode: "race"` are ignored: every started task is
  already complete when the join runs, so there is nothing to cancel.
- `Task.result` consumes once (a second call yields the zero value), matching
  the native move-out; `Task.wait` is a no-op.
- The must-start contract is not enforced: a `Thread`/`Fiber` value that is
  never started is simply dropped (the JS backend emits no auto-`#destroy`),
  and calling `.start()` twice runs the thunk once and reuses its result
  instead of aborting.

These are semantic divergences, not crashes: a cross-compiled program runs
deterministically, single-threaded.

## JS backend: array assignment aliases, native deep-copies

Recorded 2026-11-25. `var ys = xs` on an array binds a second name for the
SAME JS array on the js backend — `ys.set(0, 99)` is visible through `xs`.
The C/aarch64 backends deep-copy the element storage, so the same program
prints the original value natively and the mutated one on js. The SPEC's
"Copies, Moves and Borrows" table documents the native contract ("copy");
the js mapping needs a copy-on-bind (or an alias model with shared-ownership
checks) to match.

## JS backend: scalar closure capture sees later writes

Recorded 2026-11-25. The SPEC (and the native backends) copy scalars into a
closure at capture — a later write to the donating local is not seen. The js
backend's closure environment reads the live variable, so `var a = 1; var
func (out int) f = () => a; a = 2; f()` returns 2 on js and 1 natively.
Verified against the native build (prints 1) and `run --arch js` (prints 2).
The fix is to snapshot captured scalars into the closure object at creation,
matching the "capture is taken once" contract.

## JS backend: `ref string` element-borrow stores rebind the local

Recorded 2026-11-26 (surfaced by the slot-store closure, a332f0c4). On the
native backends a `ref string s = list.at(i)` alias names the container's
own slot, so `s = "b"` writes through (`at_or(0, "?")` reads `"b"`). The js
backend lowers the borrow to `let s = ss[idx]` — JS strings are VALUES — so
`s = "b"` rebinds the local only and the container still reads `"a"`
(verified: native prints `b b b`, js prints `a b a`). Struct element borrows
on js DO alias (list elements are JS objects; `p.id = 9` reaches the list),
so this is string-specific. Before the slot store landed the spelling was a
compile error on every backend, so no js program could depend on it; it now
compiles everywhere and silently loses the store on js. The fix family is
the same as the array-assignment entry above: either reject the
borrow-then-store shape on js, or model string slots as a cell (an object
wrapper) so aliases can observe writes.

## Use Fira Code in the bitmap share-card fallback

Recorded 2026-11-11. Share cards are rendered by Browser Run with Fira Code
(`site/src/lib/card_browser.ts`); both `pnpm dev` and `pnpm preview` carry the
remote `BROWSER` binding and use it. The pure-Worker fallback
(`site/src/lib/card.ts`: an ASCII 8x8 bitmap font) still looks rough. It is
only used when Browser Run is unavailable or fails (no binding/auth, quota, or
a screenshot error), but it could use Fira Code without a browser:

- **Precomputed alpha atlas (preferred)**: rasterize printable ASCII in Fira
  Code at the card's sizes at build time, embed the atlas (~20-40 kB gzipped),
  and blit it with coverage blending. Needs a build-time rasterizer
  (opentype.js plus a small scanline filler, or a committed atlas plus a
  regeneration script).
- **On-demand resvg-wasm**: include resvg's ~1.4 MB wasm as a static asset and
  render SVG text with the Fira Code TTF only when the fallback runs. The
  Worker script grows little, but the deployment carries a large asset.
- Either route remains ASCII-only unless a Latin-1/Unicode font subset is
  added; the browser path's ASCII subset has the same limitation for unusual
  identifiers.

Not done because Browser Run covers normal dev and production.

## Assignment-position lifting for `T ! E` bindings

Recorded 2026-11-13 from docs/ERRORS_PLAN.md's deferred item, when the plan
retired into docs/ERRORS.md — the plan's only open work. `var r = 0`
against a declared `int ! FileError` BINDING does not lift: only return
position lifts (the checker's bare-return lifting), and `expr!` propagates
from declaration initializers. Assignment lifting would apply the same
resolution order (as-is, then `T`, then `E`) to plain assignments against a
`!`-declared binding, so a result variable can be built up incrementally
without a match at every step. No in v1: no real consumer. Open design
questions when someone wants it: does the binding itself carry the set
(making every read of it checked-discarding), or does only the assignment
lift (the binding types `T`, checked-ness discharges at the lift)? And does
`r = expr!` compose with the in-flight-binding machinery the initializers
use?

## Struct layout: the 8-byte vtable word on every struct

Recorded 2026-11-25 (from the docs review's §1.6, verified against
`META.size_of`). Every struct value starts with an 8-byte vtable word —
SPEC's "Layout Introspection" states it, and the compiler matches it
exactly (`Pair { int64, int32 }` is 24 bytes, `offset_of(Pair, "b")` is 16,
`META.size_of(int)` is 8). Considered and DEFERRED: dropping the word for
structs with no trait conformance would split the struct ABI — trait casts
need the vtable AT the value, and out-of-line `extend` conformance means a
struct's trait set isn't fully known at declaration time, so "vtable only
when it conforms" forces upfront conformance declarations or boxing. The
uniform 8-byte prefix is what makes `extend` conformance, trait casts, and
the META layout surface trivial. Revisit only if small-struct array density
becomes a MEASURED problem (today's escape hatch is packing small fields
into fixed arrays or explicit numeric fields).

## Share-card tokenizer: replace Shiki on the server

Recorded 2026-11-11. `/s/<code>/card.png` tokenises with `nomen-shiki` on the
server, but a card only needs the dark-plus token colours. If the Worker bundle
needs to shrink further, a small Nomen-specific tokenizer could replace it.

## Bundle macOS GUI builds into `.app`

Recorded 2026-11-12. A `nomen build` output is a bare executable
(`build/main`), so the Dock hover label is the binary's filename — "main".
The label is not a runtime property: `NSProcessInfo.setProcessName:` has no
effect, and the LaunchServices SPI `_LSSetApplicationInformationItem` +
`_kLSDisplayNameKey` (Avalonia/WebKit's workaround) reports success and
changes what `_LSCopyApplicationInformationItem` returns, yet the Dock still
shows the executable name for an unbundled process. `lsappinfo setinfo
--name` behaves the same way. macOS resolves the hover label from the bundle
at launch, not from live process state.

Emit a minimal bundle for macOS `run`/`build` instead:

- `build/<Name>.app/Contents/MacOS/<Name>` — the linked binary.
- `Contents/Info.plist` — `CFBundleExecutable`, `CFBundleIdentifier`,
  `CFBundleName`, `CFBundleDisplayName`, `CFBundlePackageType` (`APPL`),
  `CFBundleShortVersionString`, `CFBundleVersion`, `CFBundleIconFile`,
  `NSHighResolutionCapable`, `LSMinimumSystemVersion`.
- `Contents/Resources/<Name>.icns` — generated from
  `core/assets/nomen.png` (or a project icon); the runtime
  `setApplicationIconImage:` normalisation stays for custom `set_icon` art.

Name the bundle from `package.jsonc` (`name`), and keep the folder name and
both plist names identical — the Dock has historically preferred the folder
name over the plist keys. `nomen run` should exec the inner
`Contents/MacOS/<Name>` binary (not `open -W`) so stdout, exit codes and
Ctrl-C keep working. Tests stay on bare executables.

This gives the _app_ name, not the live window title. Renaming/re-execing a
bundle at startup to track the title is possible but not worth the complexity
and double-launch.

## `#if`-unified raw blocks (COMPTIME.md stage 5) — behavior changes

- **`nomen format` and `#raw` body indentation.** Raw bodies are emitted
  verbatim (one shared body scanner with the tokenizer), so the formatter
  never re-indents them; a one-off pass normalized `core/` and the test
  fixtures to `#raw` indent + one level with internal structure preserved
  (the compiler strips per-line leading whitespace from raw text anyway —
  emitted C/asm is unindented). The formatter's layout check compares the
  tokenized BODY text, so teaching it to re-indent would need the tokenizer
  to normalize body whitespace first; a future `nomen format` pass could do
  that, purely cosmetically.

## Declaration/type generation (stage 6)

Two ideas surfaced by the stage-6 work, neither scheduled.

**Trait-conformer iteration.** `META.types_with("attr")` collects types
by attribute; the same mechanism could enumerate a trait's conformers
(`META.conformers("Sendable")`) for registry- or vtable-style
generation. It is the deepest of the iterable ideas because the
conformer set is open-ended — a conformance declared later in the file,
or in another module, must still participate — while every current
iterable is closed at the point it runs. Waiting on a concrete
consumer: runtime trait dispatch already covers the vtable case, so this
only earns its keep if generated code needs the list itself, not the
dispatch.

## Comptime residuals (from the retired plan documents)

TODOs carried over from the retired working notes `COMPTIME_PLAN.md` and
`COMPTIME_PLAN_2.md`, now folded into [`docs/COMPTIME.md`](./docs/COMPTIME.md)
and the comparison in [`docs/COMPTIME_COMPARISON.md`](./docs/COMPTIME_COMPARISON.md).

- **Type-level `#if` conditions** — conditions are limited to
  `META.arch`/`META.platform` because the fold runs before gather, so
  `#if META.info(T).field_count > 0` (or `META.is_struct(T)`) cannot
  resolve there. A second fold stage after gather (or a deferred
  type-condition pragma) would allow it.
- **Richer attributes** — arguments are single comptime literals and
  `.attr("x")` returns the first value only. D1 deferred per-field
  metadata (serde-style `default`, `skip`, `rename` grammars) until `#for`
  worked; it works now, so structured/named attribute arguments and a
  multi-value query surface are the next step for ORM/CLI-grade
  configuration.

## Resident-region extension (value-level lane allocator, phase 2)

**Attempted, reverted, designed-to-completion-minus-one-bug** (2026-11-22).
Goal: hoist the resident kernel's register/memory sync from once per block
iteration to once per `mbrot8` call — the remaining ~5-8% of the
mandelbrot residual. The committed state (item 52/53) syncs per block
because the escape check reads zr/zi from memory; feeding the escape check
from the carried v-registers requires the sync at the block-loop boundary.

What was built and reverted: `plan_resident_region` (wraps the enclosing
loop: preheader load-group before, store-group after; the inner kernel and
escape-reduce loops consume carried v-registers via a pending-plan stash),
`plan_resident_reduce` (a load-only min/max loop over carried buffers with
a literal full-width bound), and `emit_resident_reduce` (a straight-line
register-fed reduce that reuses `emit_peel_expr`'s carried-load hook).
Reverted because the classification has a hole and the fallback was wrong:

1. **Kernel/reduce misclassification**: `plan_resident_kernel` treats any
   single inner while as "the kernel" — but the escape check (a load-only
   min/max loop) ALSO plans (`plan_vector_loop` accepts the new min/max
   shape), comes back with `resident` undefined (no stores → no carried
   buffers), and the region then misfiles the J-LOOP as the reduce
   candidate. Fix design: classify the inner loop by its SHAPE — the
   kernel's inner loop must contain a STORE of a carried buffer; the
   reduce's must be store-free with all loads carried — before
   registering either.
2. **The fallback was unsound, not merely slow**: with the region
   declined, the kernel ran the memory-based peel and the escape read
   memory — that pairing is correct — but the escape's own min/max VECTOR
   reduction (which plans fine standalone) and the kernel's peel interleave
   with the region-less bracket promotions in ways the current discipline
   does not model (the all-255 receipt). The region must be all-or-nothing
   per enclosing loop, and the enclosing loop's `int_ext` gate must fire
   from the clobber set BEFORE the body builds (the
   `collect_vector_scratch_loops` mechanism, which landed and works).
3. **Build-order coupling**: `collect_vector_scratch_loops` and
   `has_resident_kernel` must run on the SAME NIR tree the emitter walks
   (`plan_nir`, not `nir.body` — the emission cursor may replace the body
   list). The landed `int_ext` gate works because both sides agree; the
   region's inner-loop pending stash keyed on AST-node identity also
   agreed in traces, but the classification hole (item 1) masked the
   verification.

Recovery path: reimplement `plan_resident_region` with shape-first
classification (store-carrying inner loop = kernel; load-only min/max =
reduce), keep the comparison-only exactness gate for the reduce, reserve
x11/x12/x13/x15 (+x14, the second-group index) with sentinel plan
allocations when a resident kernel exists (`exclude_ext_pool` — landed and
working), and gate every enclosing loop's `int_ext` off the published
clobber set (landed and working). Expected: ~5-8% mandelbrot (the per-block
24-op sync), on top of the landed −32/−33%.

**Update (2026-11-23, round 2)**: the region was re-implemented with
shape-first classification and reached a _working, correct, green_ state —
the region fires at the block loop, the kernel rides v16-v27, and the
escape check emits as a straight-line register-fed min/max reduce. The
classification fix that made it work: `plan_resident_kernel` refuses
store-free inner loops (a store-free loop is a reduce, never a kernel), and
the region classifies every child while by shape before registering (an
enclosing loop hosting the kernel span classifies as the kernel span even
though its body contains another while). Two encode fixes also landed
en route: element extraction is `mov dN, vM.d[1]` (fmov has no vector
element form) and `fminnm`/`fmaxnm` joined the IR contract.

**Result: perf-neutral (+4.8% @ n=1000, −2.4% @ n=2000, interleaved) —
reverted.** The region emits its sync at the region boundary, but an inner
region ALSO fires at the j-loop (both loops classify as regions), so the
per-block sync remains — the nested double-sync eats the escape
vectorization win. The remaining work is region-composition discipline:
`in_resident_region` must suppress the inner region entirely (the gate
exists but the inner kernel/reduce wrapping still fires through the
pending-stash path), and the outer region's sync must then be the only one.
With that, the expected win is the escape vectorization (~~+10%) plus the
per-group sync hoist (~~+5%). The scaffolding (region/reduce planners, the
comparison-only exactness gate, the clobber set, the sentinels, the .cap
discharge) is correct and green — recovery is straightforward from this
note plus the round-1 analysis below.

## `Array<T>` struct fields: remaining gaps

Dynamic `Array<T>` fields now require an `mv struct`. The struct's destroy
frees the buffer, and so does a field reassignment
(`test/array_struct_fields.test.ts`). Still open:

- **`Array.copy()` rejects elements with no copy story.** Nested arrays,
  strings and structs with a `copy()` are deep-copied; anything else that
  owns heap memory (a `Box<T>`, a struct whose fields can't be copied) is
  rejected, because the copy would share it.
- **`Array<Self>` fields crash the compiler.** `mv struct Node { var
Array<Node> kids }` overflows the stack in `layout_type_alignment` /
  `layout_struct_size` (`src/build_common/layout.ts`), with or without a
  `copy()`. Seen while adding nested `Array.copy()`.
- **`mv Array<T>` parameters don't transfer into fields.** Storing one
  (`self.items = mv other`) is rejected, because the callee's moved-param
  teardown would free the buffer the field now holds. A real transfer
  needs the callee teardown to skip a param that was moved into a field,
  on both backends.
- **Conditional moves are static on aarch64.** A heap-array donor moved
  into an owning constructor (`Holder(mv a)`) is marked
  `transferred_to_outer` (`mark_moved_if_struct`,
  `src/build_aarch64/utils/auto_destroy.ts`). A move inside one branch
  therefore also skips the free on the other path, which leaks; it never
  double-frees.

## `view` parameters of mv structs fail to compile on C

`func show = (view Holder h, …)` where `Holder` is an `mv struct` (even one
holding just a `mv string` field) emits `nomen_view` for the parameter. Field
reads through it then fail with clang errors: "member reference type
'nomen_view' is not a pointer" and "no member named 's' in 'nomen_view'".
`view` is treated as the string view type regardless of the parameter's
struct type. Seen while testing `Array<T>` fields; it is unrelated to them.

## `view string` parameters can't hold a string array's view

A `view string` parameter always means a view of a string's chars, so
`func f = (view string v)` called with `words.slice(0, 2)` (a `string[]`)
would read its elements as chars. Local views know which they are
(`Type.view_of_elements`, set by `slice` on an array), but a parameter
annotation has no spelling for "a view of strings". Needs syntax, e.g. a
distinct element-view annotation. Seen while adding `for ... of` over views.

## Binding a heap array to another name (`const w = q`)

`const Array<int> q = [7, 8]` then `const w = q; w.length` fails on C with
"member reference base type 'long' is not a structure or union": the
declaration from a plain heap-array read is emitted as `long *w`. The
ownership question is open too (alias or copy). Stores into an existing
heap-array local now require a fresh array, `mv`, or `.copy()`, but plain
declarations were not changed. Seen while adding `Array<T>?`.

## `?.` on a nullable array: remaining gaps

- **Array-valued members** (`xs?.copy()`, `grid?.at(0)` on a nested array)
  are rejected ("'?.' on a nullable array can't yield an array yet"). The
  chain-value lowering in all three backends only yields strings, scalars and
  structs; it would need an `Array<T>?` result (null pointer on the null arm),
  plus an ownership rule for the yielded buffer (a `copy()` result is owned, a
  nested row is borrowed).
- **A nullable-array field in the middle of a chain** fails: with
  `mv struct Bag { var Array<int>? xs }` and `p` a `Bag?`, `p?.xs?.length`
  reports "Field not found: length". check_null_access_node's nullable-array
  branch checks `node.target` (the `p?.xs` chain node) as an ordinary access
  target, which doesn't resolve to the array type. The guarded access probably
  needs to target the chain's value path (`p.xs`) instead, and flatten's
  `chain_value_step` must then use that re-rooted access. A direct target
  (`xs?.length`, `b.xs?.length`) works.

## Nullable call results are not null-checked before use

Only a variable that starts as a literal `null` gets the "may be null" read
error. A nullable call result is used unchecked: `const r = grid.at_or_null(9);
r.length` compiles and dereferences null at runtime. This applies to every
nullable return (`func f = (out Point?)`, `out string?`, `Array<T>?`), not just
arrays. Fixing it means marking bindings initialized from a nullable call as
possibly-null in the checker's null tracking, then narrowing them on
`!= null`. Existing code that relies on the unchecked use would start failing.
Seen while adding `Array<T>?`.
