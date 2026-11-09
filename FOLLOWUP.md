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

### Pure-Nomen 64-bit arithmetic emits looser code than a raw `#arch` body — LANDED (2026-11-02)

`Random.next` (splitmix64) is pure Nomen — verified bit-identical on both
backends — but the aarch64 output was ~40 instructions where the
hand-written body was ~14. All three gaps are closed now (PERF_PLAN item 15;
`src/build_aarch64/asm_fold64.ts` + measurements there):

1. **Constant materialization.** Full-width `movz`/`movn` + three-`movk`
   chains (4 instructions per 64-bit literal) pool into ONE pc-relative
   `ldr xN, .LC64_N` whose `.quad` entry sits right after the function's
   final `ret` (adjacent, so the ±1 MB literal reach can never overflow).
2. **Field-value forwarding.** `self.state = …; var z = self.state` no
   longer stores and then reloads the field — the reload forwards the
   stored register.
3. **Immediate shift counts.** `z >> 30` no longer pays `mov x0, #30; lsr
x0, x12, x0` — the immediate `lsr x0, x12, #30` form.

Emitted body: 39 → 25 instructions; splitmix shape −10.5% wall; suite
−4.3% nsieve / −1.9% binarytrees / −1.6% lru / flat json-serde. The raw
`#arch` bodies stay retired — the pure-Nomen spelling now lands within the
call protocol's own overhead of the raw form.

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

## json-serde: remaining uniform-heap copy costs

The Json-ownership half of the 0.7.0 run-time regression landed
(PERF_PLAN item 5 — `JsonTree.take_text`/`get_text_view`, json-serde to
−22% / −12% vs the 0.7.0 baseline). The regression's other cited causes
are untouched: uniform-heap field reads/returns in user shapes and
`List`/`Map` as `mv struct`s. Worth a pass over the Json parse path to
identify which lowered reads can stay borrows (e.g. view-returning field
reads where the caller immediately re-copies or hashes).

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
`apply_list_length_effect` (src/check/utils/flow_bounds.ts). Exact List
lengths (`known_length`), guards, inclusive bounds, singleton-range indices,
negated guards, and length-snapshot aliases discharge it. What still needs a
guard (or a contract-free spelling — `at_or_panic`, `get_or_panic`, `pop`):

- **Unknown provenance**: a list from a function return or a parameter has
  no length facts — `known_length` is stamped by guards and the modeled List
  mutators only, never at function entry or on returns.
- **Globals**: exact tracking is locals-only (`flow_bounds` bails on
  `decl.is_global`) — a global's length can change behind the caller's back
  through any opaque callee.
- **Field-path receivers** (`h.items.at(0)`, `ref int v = h.items.at(0)`):
  guards only — `extract_equality_length` records exact facts on bare
  variable names, so `h.items.length == 3` establishes nothing. Empirical
  note (2026-11-09): even a length guard does not discharge `at`'s
  contract on a path — the guard records `path_bounds` on the base
  variable, but the contract normalizes to `0 < h.items.length`
  (literal left, path right) and the evaluator never consults the path's
  lower bounds in that direction. Closing it soundly needs the shrink
  narrowing (`apply_list_length_effect`'s sweep) extended to path facts —
  bundle with the mutation-precision pass below rather than flipping the
  consultation alone. `at_or_panic` is the sanctioned spelling meanwhile.
- **Guard-fact staleness on unmodeled mutators**: guard-derived bounds on a
  receiver survive `ref self` calls the model doesn't know (only the exact
  fact dies); the length-effect model covers List's
  push/pop/remove_at_or_panic only. Closing that means a mutation-precision
  pass (refine-vs-invalidate per callee effect) — worth doing only with
  concrete blocked shapes.
- **Containers other than List/Map**: `Tree` has no contract-free read;
  `LinkedList` has `at_or`/`at_or_panic`, but its elements are heap nodes —
  no slot primitive, so its reads never rewrite to element borrows — and
  neither container is in the length-effect model.

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
