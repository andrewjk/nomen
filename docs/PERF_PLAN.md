# PERF_PLAN.md — Performance Plan

Research into the next performance opportunities, following the StableList +
in-place push work. PERF.md is the record of what landed; this is the plan for
what's next. All findings are ordered most-promising-first. Written Oct 2026;
originally unmeasured — items 2, 3, 4 (partially), 5, 6, 7, 8, 9, 10, 11, 12,
and 14 have since landed with measurements in place (items marked LANDED carry
them; the rest carry expected wins and the receipts they rest on).

> **Measurement context (2026-11).** Receipts in this document are
> **same-context relative measurements**: before/after binaries built and
> interleaved inside one session, so the recorded ratios are internally
> consistent. Two caveats apply when reading them:
>
> 1. **Absolute wall-clock values are context-relative.** Sessions run from
>    agent shells measure on whatever core class / clock state the machine
>    offers that day (see docs/scratch/ALLOCATOR_PLAN.md and FOLLOWUP.md,
>    "Context measurement hazard"): allocation-heavy (fault/mmap-churning)
>    code read ~35–60% slower (user time) in some agent sessions than an
>    interactive terminal, while pure compute and memory-reusing workloads
>    measured context-equal, and machine state drifts across a session. Do
>    not compare an absolute number here against your own interactive run;
>    compare ratios, or re-measure interactively.
> 2. **A ratio is distorted if before/after differ in clock-sensitivity
>    class.** This happened exactly once: item 1 swapped a clock-bound
>    allocator (libc) for a latency-bound one (freelist), producing phantom
>    −22%/−31% receipts that vanish on P-cores (withdrawn;
>    docs/scratch/ALLOCATOR_PLAN.md). Items that reduce _work_ (copies,
>    mallocs, instructions) with both sides on libc keep valid ratios.
>    Cache-pressure reductions may read somewhat larger on efficiency cores
>    (smaller L2) than interactive — spot-check before quoting those as
>    interactive numbers.

| #   | Item                                                                                                                                                                                                                                                                                                                                                 | Backends       | Effort | Receipt                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ | ------------------------------------------------ |
| 1   | ~~Faster allocator (slab/bump class allocation)~~ **ATTEMPTED + REVERTED Nov 2026: complete, tested runtime — P-core-NEUTRAL on every bench (trees/json-serde/lru/nsieve, both backends); the apparent win only existed in agent-shell measurement contexts (mechanism verified NOT QoS — see record). Full record: docs/scratch/ALLOCATOR_PLAN.md** | both           | M      | PERF.md "Large"; ASM_TODO "largest unclaimed"    |
| 2   | ~~In-place push for constructors~~ **LANDED Oct 2026: −55% / −58% on the shape; field-path receivers −24% / −30% sample.json, −25% / −32% string-heavy doc; tranche completed (local roots, Box/generic hops, donor) −51% / −52% on the field-path shape bench**                                                                                     | both           | S      | shape micro-bench, interleaved medians (below)   |
| 3   | ~~Move-on-last-use for structs~~ **LANDED Oct 2026: −20% / −29% on the shape**                                                                                                                                                                                                                                                                       | both           | S–M    | shape micro-bench, interleaved medians (below)   |
| 4   | ~~Borrow-returning reads (Map `get_ptr`, `at_view`)~~ **LANDED Oct–Nov 2026: Map slot borrow −79% / −98% on the borrow shape, −48% probe fusion; for-of + expression-temp element borrows −32% / −30% on the read-sweep shape (Nov); the struct-`view` half is the follow-on item**                                                                  | both           | M      | shape micro-benches, interleaved medians (below) |
| 5   | ~~Json ownership copies~~ **LANDED Oct–Nov 2026: −26% / −13% on the ownership shape, −22% / −12% json-serde; the null-seed tranche (Nov) −38% / −15% sample.json, −19% / −9% string-heavy; the mv-string tranche (Nov) −45% / −24% on the store shape — item complete**                                                                              | both           | S      | measured 0.7.0 regression +61% / +103%           |
| 6   | ~~In-place store (`set`/`insert`/`add`/`alloc`)~~ **LANDED Oct–Nov 2026: −50% / −56% on the pure store shape, −64% Map replace; the add/alloc siblings (Nov) −18% / −10% via the transfer store — item complete**                                                                                                                                    | both           | M      | shape micro-benches, interleaved medians (below) |
| 7   | ~~Enum payload in-place construction~~ **LANDED Oct 2026: −45% / −8% on the payload shapes (aarch64; C take-variant)**                                                                                                                                                                                                                               | both           | S–M    | shape micro-benches, interleaved medians (below) |
| 8   | ~~Regex/String O(n²) accumulators~~ **LANDED Oct 2026: −92% / −91% match accumulator, −65% / −58% replace_all skip loop, −33% / −40% String.replace_all, −28% / −14% array to_string**                                                                                                                                                               | both           | S      | shape micro-benches, interleaved medians (below) |
| 9   | ~~Map/Set stored hash (Swiss-table tricks)~~ **LANDED Oct 2026: −35% / −52% probe shape, −21% / −49% string build+remove, −19% / −33% Set build, −22% aarch64 int rehash; int-keyed hit paths +2–10% (below)**                                                                                                                                       | both           | M      | shape micro-benches, interleaved medians (below) |
| 10  | ~~StringBuilder numeric appends + 1-pass interp~~ **LANDED Oct 2026: −80% / −79% interp, −76% / −75% numeric append, −66% / −70% new-spelling**                                                                                                                                                                                                      | both           | S      | shape micro-benches, interleaved medians (below) |
| 11  | ~~Devirtualization of trait calls~~ **LANDED Oct 2026: −12% realistic callee / −31% trait-default (C), tiny-callee loop folds outright; aarch64 inline splice −19% (below)**                                                                                                                                                                         | both           | M      | shape micro-bench, interleaved medians (below)   |
| 12  | ~~Struct field-order / padding~~ **LANDED Oct 2026: −10% / −12% shape (aarch64 / C), −20% peak RSS on the shape; standard suite flat**                                                                                                                                                                                                               | both           | S      | shape micro-bench, interleaved medians (below)   |
| 13  | ~~Variable-mode enums~~ **PARTIALLY LANDED Oct–Nov 2026: case types (`Enum.case`) — −53% / −31% time, −49% RSS on the shape; case types over generic enums + base↔case conversions (the checked cast) LANDED Nov 2026; variable-stride arrays + whole-enum runtime-variable mode remain**                                                            | both           | L      | shape micro-bench, interleaved medians (below)   |
| 14  | ~~Buffer word pairs (T_SIZE ≤ 16)~~ **LANDED Oct 2026: −12% / flat shape (aarch64 / C — clang already inlined it); json-serde flat (no 16-byte element exists)**                                                                                                                                                                                     | mostly aarch64 | S      | shape micro-bench, interleaved medians (below)   |
| 15  | aarch64 codegen receipts (splice model, folds…) — **the 64-bit arithmetic folds LANDED Nov 2026: `Random.next` body 39 → 25 instructions, splitmix shape −10.5%; suite −4.3% nsieve / −1.9% binarytrees / −1.6% lru / flat json-serde (below)**                                                                                                      | aarch64        | S–M    | measured regressions to reclaim                  |
| 16  | Async paths audit                                                                                                                                                                                                                                                                                                                                    | both           | ?      | unexplored, unmeasured                           |
| 17  | ~~Minor batch~~ **LANDED Oct 2026: `List.remove_at_or_panic` bulk tail move −91% / −61% (17a); StableList tail push direct view store −14% aarch64 / flat C (17b); `Array.set` in-place producer store −51% / −48% (17c); `json_parse_string`/`number` scan + bulk append −44% / −33% on string-heavy docs, json-serde −12% / −9% (17d)**            | both           | S      | assorted                                         |

## Remaining remainders, ranked (Nov 2026)

The open remainders across the items above, ordered by expected
improvement per unit of effort. "Expected" for unmeasured entries rests on
the receipts each item's row names; statuses cross-checked against git
history. Items 2–7 are "this week" material; item 1 was attempted and
reverted (Nov 2026 — P-core-neutral, docs/scratch/ALLOCATOR_PLAN.md), and
the tree benches' remaining cost is latency-bound codegen, not allocation;
items 9 and 10 are the only entries expected to move a headline bench
number.

| #   | Remainder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Effort | Expected win                             | Note                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~Item 1 — faster allocator (slab/bump)~~ **ATTEMPTED + REVERTED Nov 2026: P-core-neutral on every bench measured (trees, json-serde, lru, nsieve, both backends — docs/scratch/ALLOCATOR_PLAN.md). With allocation made cheap the tree benches are pointer-chasing/cache-latency-bound (the allocator build's spread across measurement contexts is a fraction of the HEAD build's), so there was no clock-bound allocator cost left to remove. The apparent Large win only existed in degraded/agent-shell measurement contexts. Implementation preserved on branch allocator-eager.** | M      | ~~Large~~ **none (P-core)**              | "Largest unclaimed lever" — the lever wasn't where it seemed: the remaining tree-bench cost is the Box store/destroy walk and call overhead (latency-bound codegen), not malloc/free. |
| 2   | ~~Item 15 — 64-bit arithmetic folds (constant materialization, field-value forwarding, immediate shifts)~~ **LANDED Nov 2026: `Random.next` body 39 → 25 instructions, splitmix shape −10.5%; suite −4.3% nsieve / −1.9% binarytrees / −1.6% lru / flat json-serde (item 15 below)**                                                                                                                                                                                                                                                                                                     | S–M    | ~~Medium, aarch64-only~~ **done**        | `Random.next` ~40 → ~14 instructions; generalizes to all pure-Nomen 64-bit math. Invisible on C.                                                                                      |
| 3   | ~~Items 10/8 — writer-form interpolation lowering (append arguments straight into the helper's buffer)~~ **LANDED Nov 2026: int shape −62% / −58% (aarch64 / C), mixed shape −35% / −36%; standard suite flat ±1.1% (item 10 below)**                                                                                                                                                                                                                                                                                                                                                    | S–M    | ~~Medium on string-heavy code~~ **done** | Drops one malloc per numeric interpolation argument; the landed interp tranche proved these paths hot (−80%). Hand-rolled `%f` excluded — one snprintf is fine.                       |
| 4   | ~~Item 17r — Map/Set.remove bulk `move_range`~~ **REJECTED Nov 2026: the shape lands −52% / −11% but lru pays +4–6% / +2–4% — the count-before-shift probe tax on its short random chains; no variant avoided it (17r below)**                                                                                                                                                                                                                                                                                                                                                           | S      | ~~Small–medium~~ **net negative**        | 17a's List receipt (−91%) proves the shape; Map/Set's probe loop makes it less blocky, so less of the win.                                                                            |
| 5   | ~~Item 13(3) — base↔case conversions~~ **LANDED Nov 2026: case→base at declaration+assignment (Nov), base→case as the explicit checked cast (`r as Res.ok` — runtime tag check + panic on variant mismatch, COPY semantics; the implicit conversion stays a type error). Remaining surface: argument/return/container conversion sites, static discharge of the check in provable flow contexts**                                                                                                                                                                                        | S–M    | ~~Feature-completion~~ **done**          | More completion than perf; unblocks `Option<int>.some`.                                                                                                                               |
| 6   | Item 9r — hash tag packed into the `used` word                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | S      | Small                                    | One load less per probe; only pays if int-keyed hit paths matter (they currently PAY +2–10%).                                                                                         |
| 7   | Items 14r/17br — StableList 24/32-byte pair stores + bulk `copy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | S      | Small, aarch64-only                      | Waiting on a hot chunked-storage shape; the ≤16 work showed C is already flat.                                                                                                        |
| 8   | Item 2r — index/call-segment push receivers (`rows.at(0).items.push(Ctor(...))`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | S–M    | Small in practice                        | −50%-class per site but no booked workload; scope to slot-borrow segments only, policing the alias with item 4's borrow registry.                                                     |
| 9   | Item 4r — struct-`view` (field access through a view value)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | L      | Potentially large                        | Borrow reads measured −30%; but a language-design item (view over struct fields, nested borrow rules undesigned). Highest ceiling, highest cost.                                      |
| 10  | Item 13(1,4) — true variable-stride arrays + whole-enum runtime-variable mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | L      | Large where applicable                   | Case monos already took −49% RSS; variable-stride needs a packed container family.                                                                                                    |
| 11  | Item 16 — async paths audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ?      | Unknown                                  | Only if GUI/async is a real target.                                                                                                                                                   |
| 12  | Item 12r — trait-field packing gap + `_has` flag grouping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | S–M    | Tiny                                     | No System struct affected today.                                                                                                                                                      |
| 13  | Item 7r — method-call enum payload arguments (`Res.ok(seed.copy())`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | S–M    | Small                                    | Needs the C per-argument heapness classifier (the take label is per-call).                                                                                                            |
| 14  | Item 11r — trait devirt extensions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —      | —                                        | Blocked (trait fields, STRUCT_PLAN_3 B5) or a different analysis (container elements). Parked.                                                                                        |
| 15  | Items 3r/8r — enum-with-data donors; `String.replace_first`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —      | ~zero                                    | By-design non-elisions — nothing to win. Don't.                                                                                                                                       |

## 1. Faster allocator — slab/bump the class-allocation path — ATTEMPTED, REVERTED (Nov 2026)

PERF.md's only "Large" row; ASM_TODO called it "the largest unclaimed perf
lever". Every class instance mallocs in the magic ctor
(`src/build_aarch64/build_magic_ctor.ts`, same shape in the C backend);
binarytrees/merkletrees are allocation-dominated and the tree benches
regressed further with the class→mv-struct+Box idiom ("alloc + struct memcpy
per child now", FOLLOWUP.md).

**A complete, tested allocator was built and measured** (`src/nomen_alloc.c`
— mmap reserve + per-class slabs + page map + thread-local freelists, libc
above 4 KB, audit-ledger integration with a quarantine; zero emitter churn
via the audit layer's mapping seam) and **reverted**: on performance cores
it is neutral on every bench measured (binarytrees 1.42→1.43 aarch64,
1.00→0.965 C; merkletrees, json-serde, lru, nsieve flat), because once
allocation is cheap the tree benches are pointer-chasing, cache-latency-bound
— much less sensitive to machine state than the clock-bound allocator path
they replace — and the tree walk dominates either way. The
original −22.9%/−30.9% receipts were a measurement-context artifact (the
same binaries read consistently slower in agent-spawned shells than in an
interactive terminal on this fanless M2 Air; libc's fault-churning
allocator path takes that penalty and the fault-free freelist doesn't —
the QoS/E-core mechanism was tested and REFUTED, see the record). Full story, P-core receipts, and
the measurement caveat: **docs/scratch/ALLOCATOR_PLAN.md**. The
implementation lives in `stash@{0}`.

## 2. In-place push for constructors — LANDED (Oct 2026)

**What landed.** The `in_place_call_ok` gate
(`src/check/check_function_call.ts`) no longer rejects the constructor shape:
an argument call whose name resolves to a non-simple, non-class, non-generic
struct is now stamped like any other producer — the callee is the struct's
`#init` (auto-generated or user-written), whose emission is unconditional, so
the foreign-callee `has_body` clause doesn't apply to it. Both backends
construct the result straight into the container's fresh slot, reusing the
tranche-4 x8 threading as predicted:

- aarch64: `build_function_call_node` gained a preset-window branch for value
  structs — when `call_x8_preset` + `call_x8_slot_offset` are set (the
  in-place push and NRVO-donor windows), the ctor's hidden destination (x0)
  loads the spilled slot address instead of allocating a `_temp_N` home, and
  the post-call tail reloads the same address. The x8 re-preset-per-argument
  carried over unchanged.
- C: no backend change was needed — the in-place lowering already builds the
  argument as the RHS of the append-slot assignment, which a ctor expression
  satisfies verbatim.
- Checker hardening found on the way: the stamp now also requires the
  CALLEE-side element type (`mv T value`) to be in-place-eligible. A
  `mv Trait` push param stores boxed handles per slot, so
  `pets.push(Dog("Rex"))` into `List<Speaker>` — the arg's concrete type is a
  value struct, but the container stores handles — keeps the hoisted + boxing
  path. Without this the aarch64 backend built a 16-byte struct into an
  8-byte handle slot (the trait-collection tests caught it).
- One latent assembler bug fell out: the in-place window's per-argument x8
  re-preset could glue onto an unterminated leaf emit (`mov x0,
#90ldr x8, …`) — several immediate/char-literal emitters leave the buffer
  unterminated and had only been saved by the _following_ `ensure_newline`.
  The re-preset now ensures the newline first.

`push(Res(7))`, `push(Person(...))`, `push(TextRule())`, the zero-arg
`push(JsonNode())` pool shape, custom-`#init` ctors, and the donor spelling
(`var p = Res(...); push(mv p)`) all lower in place now; nine tests in
`test/list_in_place_push.test.ts` pin the shapes and the emitted code, and
the full suite (521 files, both backends) passes.

**Measured.** Shape micro-bench — 3×2M `recs.push(Rec("item", i, i*2, i*3))`
into a local `List<Rec>` (mv struct: string + 3 ints), n from argv, Apple
Silicon, best-of-5 plus interleaved medians, audit off:

| Backend | before | after |        Δ |
| ------- | -----: | ----: | -------: |
| C       |  0.44s | 0.20s | **−55%** |
| aarch64 |  0.52s | 0.22s | **−58%** |

Per push the elided work is exactly the tranche's promise: the ctor's seed
strdup remains (it is the store), but the temp home, the push-callee
deep-copy (a second strdup + struct memcpy), and the temp teardown disappear
— 2 mallocs + 1 free per push become 1 malloc. The standard suite is
unchanged (json-serde 0.05/0.07s, binarytrees 1.40/1.83s, lru, nsieve —
identical before/after on both backends): none of its hot loops contain the
bare-local ctor-push shape yet.

**Field-path receivers (the remainder above, landed Oct 2026).** The
receiver side of the guarantee now accepts `self.<field>...` chains of
plain value-struct field hops, so `JsonTree.alloc_node`'s
`self.nodes.push(JsonNode())` constructs in place:

- **Checker** (`src/check/check_function_call.ts`): the identical
  bare-local clauses of the push and store gates are one
  `in_place_receiver_ok` helper, extended with the field-path branch —
  root `self`, every hop an `access_field` whose owner is a
  non-generic, non-class, non-simple struct (intermediate hops read
  their stamped access types). The soundness story is the receiver's
  stability: nothing the splice runs can rebind a method's `self`
  (callees cannot see it — functions don't close over it, and lambdas
  and `ref`-argument callees are rejected by the existing arg gates), so
  `self + Σ static offsets` cannot move between the slot capture and
  the length bump. Array receivers keep the bare-local rule (their
  element-base math is name-keyed), and the DONOR form keeps it too —
  the donor stamps address the receiver by bare name, so a field-path
  `var p = X(); self.nodes.push(mv p)` keeps the ordinary (sound) mv
  transfer.
- **Shared facts** (`src/build_common/in_place_push.ts`):
  `in_place_receiver_path` reduces a receiver to (root, field hops) or
  nothing (an index or call segment anywhere in the chain refuses), and
  `in_place_field_path_owners` walks the field types against the struct
  table to the container's mono — the same walk the checker re-derives
  before stamping, so a stamp always resolves.
- **aarch64**: the reserve/append-slot/bump addressing gained the
  field-path form — the receiver base (x19 for the mv-struct method
  receiver, the spilled struct-param slot for `var self`) plus the
  summed static offsets (`add x0, x19, #8`), re-derived after each `bl`
  exactly as the bare-local form re-derives by name.
- **C**: the splice spells the receiver `self->nodes` (methods take
  `struct T* self`; a custom `#init`'s by-value self spells dots).

Seven tests in `test/list_in_place_push.test.ts` pin the runtime shapes
(the `JsonNode()` pool push through `self.nodes` with audit on, a
producer push across the growth boundary, the donor fallback, the `set`
sibling through a field path) and the emitted code (the C `&self->nodes`
spelling, the aarch64 `add x0, x19, #8` receiver math, no `bl ..._push`
at the sites); the full suite (539 files, both backends) passes.

**Measured.** `bench/nomen/json-serde.nm` — the workload the remainder
was booked against: every parsed node pays `alloc_node`'s push. n from
argv, Apple Silicon, 7 interleaved rounds, medians, audit off, release
builds, identical outputs before/after; "before" binaries built from a
HEAD worktree. The emitted diff is one semantic hunk on both backends
(the splice; everything else is label-counter renumbering): the temp
home, the push-callee struct copy, and the temp teardown disappear —
2 mallocs + 1 free per node become 1 malloc (the ctor's seed strdup,
which is the store).

| Document                     | Backend | before (median) | after (median) |        Δ |
| ---------------------------- | ------- | --------------: | -------------: | -------: |
| `bench/sample.json`, n=50000 | aarch64 |          0.620s |         0.472s | **−24%** |
| `bench/sample.json`, n=50000 | C       |          0.354s |         0.246s | **−30%** |
| 2000×200-char doc, n=3000    | aarch64 |         22.051s |        16.458s | **−25%** |
| 2000×200-char doc, n=3000    | C       |         12.888s |         8.744s | **−32%** |

The standard suite is flat on aarch64 (binarytrees 18: 1.837 → 1.829s,
lru `1000 20000000`: 1.712 → 1.711s, nsieve 12: 0.158 → 0.158s; outputs
byte-identical): no other bench hot loop pushes a ctor through a field
path.

**The rest of the field-path tranche (landed Oct 2026).** The gate's
remaining shapes — all sound by the same argument (nothing the splice
runs can rebind the root), now stamped:

- **Roots beyond `self`**: a non-param LOCAL (`t.nodes.push(Rec(...))` in
  `main`). Globals stay excluded (they sit below
  `function_value_base` — a callee could reassign a global's field,
  stranding the captured slot); `ref` bindings stay excluded (their slot
  holds a pointer, so the root's base address is not the slot's
  address); params keep the bare-local rule's exclusion (their
  by-address spelling differs).
- **Class-typed hops**: a hop whose field type is a class instance LOADS
  the instance pointer the field slot holds (aarch64 `ldr`, C `->`)
  instead of adding into inline storage — and since `class` retired in
  favor of `Box<T>` sharing, the shape arrives post-rewrite: the
  transparent Box rewrite spells the chain `engine.__value.events`, the
  wrapper mono is a class (pointer hop), and `__value` itself is inline
  in the pointee (add hop), so `self.engine.events.push(Rec(...))`
  constructs into the shared list's slot via
  `&self->engine->__value.events`. Generic owners resolve through their
  materialized monos (`self.hold.items` where `hold: Holder<string>`
  walks `Holder_string`'s layout). Refused: nullable non-class hops (no
  pointer slot to load), view/ref/array-typed hops, generic templates,
  and trait-typed hops (a trait field's boxed-handle slot is not the
  walk's shape); class/Box ROOTS stay excluded (the root's slot holds a
  pointer the addressing would have to deref).
- **The donor form through a field path**: `var p = Rec(...);
self.nodes.push(mv p)` now converges on the in-place lowering — the
  stamp carries the path (`DeclarationNode.in_place_push_slot.
receiver_field_path`), and both backends' declaration and length bump
  re-derive the same walk, falling back TOGETHER to the ordinary
  declaration + ordinary push when it fails (a mismatched fallback would
  double-push).
- **Index/call segments stay excluded** (`self.rows.at(0).items`): the
  splice re-derives the receiver address after every `bl`, and a call
  segment's re-derivation would re-run the call — soundness would need a
  can't-mutate proof about arbitrary callees, a different analysis.

Six new tests in `test/list_in_place_push.test.ts` (thirteen in the
field-path block) pin the runtime shapes — local root, Box hop,
generic owner, donor convergence (audit on, so every slot and the shared
engine's slots are freed exactly once) — and the emitted code (the C
`&self->engine->__value.events` spelling, the aarch64
`ldr x0, [x0, #8]` wrapper load with the summed inline offsets, the
donor binding's non-materialization); the full suite (539 files, both
backends) passes.

**Measured.** Shape micro-bench — `bench/nomen/field_path_push.nm`: three
shapes back to back, n pushes each (local root, Box hop, donor through a
path) of a computed-payload ctor, then pop-and-accumulate sweeps (one
checksum over all three; identical before/after). n = 2M, Apple Silicon,
7 interleaved rounds, medians, audit off, release builds; "before"
binaries built from a HEAD worktree. The elided work is the ctor shape's
promise — temp home, push-callee struct copy, temp teardown (2 mallocs +
1 free per push become 1 malloc) — with the receiver addressing (a
pointer load or an extra add, amortized over the push) as the only new
cost. The C diff receipts it: `List_Rec_push(&t.nodes, &<temp>)` becomes
reserve + construct + length bump through `&t.nodes`, `&b.recs->__value`,
and `&d.nodes`.

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| aarch64 |          0.569s |         0.279s | **−51%** |
| C       |          0.442s |         0.210s | **−52%** |

**Remainder.** Index/call-segment receivers only (the different-analysis
case above); everything else the tranche enumerated is landed or
explicitly refused by the gate.

## 3. Move-on-last-use for structs — LANDED (Oct 2026)

**What landed.** The build-time last-use pass
(`src/check/utils/last_use.ts`) gained a second shape beside the string one:
`a = b.copy()` / `var a = b.copy()` where the call resolves to the
SYNTHESIZED deep-copy method (`copy` of a copyable value struct — a
user-written `copy` never carries the new
`FunctionNode.is_synthesized_copy` marker, so arbitrary `copy` methods are
never touched) and `b` is provably dead after the site. The whole-function
single-use counting machinery (reads, loop back-edges, spawn opacity, raw
bodies, re-assignment refusal, param/const exclusion) is shared with the
string pass. On a hit the RHS is REWRITTEN to `mv b` — the exact AST a
hand-written transfer produces — so both backends' existing, tested
explicit-mv lowerings do the work with zero backend changes: donor cleanup
spliced away, displaced-value reclaim kept, moved-flag guards for
conditional paths. The kill-switch restores the `.copy()` RHS on rebuild,
and the rewrite is idempotent across repeated builds of a shared AST. The
guard set turned out to matter: the D3 ownership rules already force every
cross-variable struct transfer through `mv`/`.copy()`, so the implicit deep
copy the item imagined doesn't exist — the explicit `.copy()` call IS the
deep copy being elided. Thirteen tests in
`test/struct_last_use_move.test.ts` pin the transfer, the guards (later
read, back-edge re-read, self-assignment, const/param donors, raw bodies)
and the emitted shape; the full suite (521 files, both backends) passes.

**Measured.** Shape micro-bench — 3×2M iterations of `var dst = src.copy()`
on a fresh local `Rec` (mv struct: string + int + `List<int>` of 2
elements), donor dead each iteration, n from argv, Apple Silicon, best-of-5
plus interleaved medians, audit off, identical outputs:

| Backend | before | after |        Δ |
| ------- | -----: | ----: | -------: |
| C       |  0.63s | 0.51s | **−20%** |
| aarch64 |  0.92s | 0.66s | **−29%** |

Per iteration the elided work is exactly the item's promise: `Rec_copy`
(a fresh init, a strdup per string field, a fresh `List` malloc + slab copy,
a temp struct copy) and the donor's scope-exit destroy become one bare
struct byte copy with the donor's cleanup spliced away — 3 heap allocations
per iteration become 1 (the seed strdup, which is the store). The standard
suite is unchanged (json-serde, binarytrees, lru, nsieve: byte-identical
outputs, flat timings on both backends) — no bench hot loop contains a
last-use struct `.copy()` yet. In particular the tree benches this item was
booked against stay flat: their per-child cost is the `Box<T>(mv node)`
ctor shape (alloc + struct memcpy — items 1/7/14), not a last-use copy.

**The transfer-position tranche (landed Oct 2026).** The rewrite now covers
the other ownership-transfer positions, not just whole-RHS declare/assign.
The same donor test (no read of the source may execute after the copy, with
the whole-program loop/back-edge/spawn/refusals the pass already implements)
classifies each site, and the rewrite is again the exact AST the explicit
spelling parses into, so both backends' tested explicit-`mv` lowerings do
the work with zero backend changes:

- **`return src.copy()`** → `return mv src`. The return builders already
  treat a bare-local struct value as a transfer (the C backend splices the
  returned declaration from the scope frames and drops its heap-field
  records so the return-path reclaim keeps the bytes being handed out), so
  the rewritten return is the hand-written `return mv src` shape.
- **Container stores** — `list.push(src.copy())` (any argument position
  whose callee parameter is `mv`-declared). The checker had hoisted the
  argument into a `const _param_N = src.copy()` allocation; the rewrite
  splices that allocation out of the statement, puts the bare `mv src`
  donor in the parameter slot, and stamps `move_param_indices` — the exact
  three artifacts the explicit spelling produces — so the donor cleanup
  (splice or moved-flag, both backends) runs unchanged. The synthesized
  copy and its temp home drop out; the store itself is the push's own
  `mv T` slot copy, as in the explicit donor form.
- **Field stores** — `obj.field = src.copy()` → `obj.field = mv src`, the
  transfer lowering the assignment builders already implement for explicit
  mv field stores.
- **Free-function call arguments** — `consume(src.copy())` where `consume`
  takes `mv Rec` — the same hoisted-temp splice as the container store.
  An argument whose callee parameter is NOT `mv`-declared never rewrites:
  the checker rejects `mv` into a borrow parameter, so that rewrite would
  build a spelling the language refuses.
- **Container-typed donors** — `var dst = list.copy()` where `list` is a
  `List`/`Map`/`Set` `var` local: the library copy is a fresh-value copy of
  the same shape as the synthesized struct copy, and the container `mv`
  transfer (slab hand-over, donor spliced from the scopes) exists on both
  backends. The receiver recognizer admits a copy call whose receiver's
  stamped type names a container; user `copy` methods are still never
  touched (only the synthesized-struct marker or a container type name
  qualify).

Two guard refinements came with the positions. Sites are processed in
program order and a donor already moved by an earlier site refuses later
ones — two `x.copy()` sites in a row rewrite only the LAST (the earlier
copies are real: the program reads `x` between them), which also closes a
latent double-move on the landed declare shape. And the read test's
skip-window narrowed for call sites: only the hoisted allocation's own
interval is exempt, so a SIBLING argument reading the donor
(`f(src.copy(), g(src))`) refuses the rewrite.

Nine new tests in `test/struct_last_use_move.test.ts` (twenty-two total)
pin each position's transfer with the auditor on (both backends: return,
push, field store, List donor, `mv`-param call argument) and each position's
guard (a later read of the donor keeps the copy; emission-pinned, so the
assert is the rewrite decision, not the leak state). The full suite (539
files, both backends) passes. No new shape bench was taken: the elided work
per site is exactly the item's measured promise (the synthesized copy — a
fresh init, a strdup per string field, a fresh container per `List` field —
drops out; what remains is the explicit-mv transfer the sites' lowerings
already performed), and the standard suite contains no hot-loop
last-use copy sites beyond the ones the item's table already receipts (the
LANDED entry's suite timings cover those; the 539-file suite's runtime
tests — which build and run the bench-adjacent shapes — pass unchanged).

**The nested-expression tranche (landed Nov 2026).** The call-argument
rewrite now covers arguments nested inside a larger expression
(`acc = acc + consume(src.copy())`), and the `Map.set(k, src.copy())`
two-argument store is pinned. The blocker was attribution, not analysis:
`promote_allocations` attaches the pending hoisted temps to the first
checked node whose stack parent is a block, and for a call nested in an
expression that node is the CALL itself (op/assign never push the checker
stack) — so the temp hung off the call node (for a method call, the whole
ACCESS node), where the walk's statement-level `alloc_frames` never
looked. The walk now frames a call's own `allocations` at the call's
position (`walk_call_allocations`): the temp's declare interval exists for
the classify's skip window, its body's reads are recorded (a sibling
hoisted temp reading the donor after the call now counts as the real read
it is), and the live array rides the record as the nearest frame, so the
splice lands on the AST wherever the checker parked the temp. The
classify is unchanged (temp-name matched, so a shared chain frame cannot
misattribute), and the kill-switch restore already reached the nested
nodes via `child_nodes`.

Five new tests in `test/struct_last_use_move.test.ts` (twenty-seven total)
pin the free-call and method-call nested shapes and the `Map.set`
two-argument store with the auditor on (both backends), the nested-site
guard (a read of the donor after the call, inside the same statement,
keeps the copy), and the kill-switch restore of a nested site's spliced
temp. The full suite passes. Two pre-existing lowerings surfaced on the
way — an owning read of a user-struct-valued Map freed the slot's aliased
string fields (plain `get` sat outside the borrow-accessor family, so its
receiver carriers and bindings missed both the carrier stamp and the B1
strdup repair), and the aarch64 callee skipped the mv-param teardown for
METHODS (the free-function path seeded the param's string records; the
method path never did). Both reproduce with the explicit spellings alone;
both have since landed (2026-11-01 — the declaration-side gates admit the
library containers' plain `get` by receiver type, and the method path
mirrors the free path's registration) and the tests no longer route
around them.

**Measured.** Shape micro-bench — `bench/nomen/last_use_nested_call.nm`:
two shapes back to back, n sites each (free-call and method-call, both in
`acc = acc + f(src.copy())` position) of a computed-payload `Rec`
(mv struct: string + int + `List<int>` of 2 elements), donor dead each
iteration, n from argv, Apple Silicon, 7 interleaved rounds, medians,
audit off, release builds, identical outputs; "before" binaries built
from a HEAD-worktree compiler. The emitted diff is the two sites'
`_param_N = Rec_copy(&src)` hoist + temp teardown becoming the bare `mv`
donor pass (no `bl Rec_copy` / `Rec_copy(&src)` at the sites); everything
else is label renumbering.

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| C       |           0.42s |          0.17s | **−60%** |
| aarch64 |           0.97s |          0.49s | **−49%** |

Per site the elided work is the item's promise: the synthesized copy (a
fresh init, a strdup per string field, a fresh `List` malloc + slab copy
per container field, the temp struct copy) and the donor's scope-exit
destroy — 2 mallocs + 2 frees per iteration become 1 + 1 (the seed
strdup, which is the store; the callee's mv teardown frees the
transferred state). The standard suite is untouched: json-serde's
generated C is byte-identical before/after (a 0-line diff — the tranche
changes no emission the suite reaches) and flat at the measurement size
(`bench/sample.json 50000`: 0.23–0.25s both, identical outputs).

**Remainder.** Donors whose type is an enum-with-data stay out of scope
by design (the mv convention deep-copies those at the boundary, so a
rewrite would be sound but not an elision).

## 4. Borrow-returning reads — LANDED (Oct–Nov 2026; the struct-`view` half is its own design item)

**What landed.** The Map value slot borrow. `Map.get_ptr(key) -> ptr TV`
(`core/System/Map.nm`) is `Buffer.slot_ptr` for Map values: one probe
(`find_slot` + the `used` check — the `has` + `get` pair collapses into it),
then the mapped slot's address, so container-bearing values stop paying the
owning-specialized deep copy on every lookup and the LRU-style hit path
stops paying a second probe. It traps on an absent key (a missing key is a
bug at a slot-borrow site; miss-as-case lookups keep `get_or`). INTERNAL,
like every slot-borrow primitive (`List`/`Buffer`/`StableList`/
`ClassBuffer.slot_ptr`, `StableList.append_slot_ptr`): the raw pointer must
not cross the library boundary, so user code reaches the family only
through the element-borrow rewrite below — and since the checker checks
visibility on the pre-rewrite spelling, the marker costs the lowering
nothing.

`ptr` returns are library-only, so user code reaches the primitive through
the ELEMENT BORROW, extended to a second read spelling: `ref TV v =
map.get_or_panic(k)` is rewritten in place to `get_ptr(k)` — the same
lowering `ref T x = list.at(i)` has always gotten from `slot_ptr`
(`src/check/check_declaration_node.ts`, `element_slot_load`). The rewrite is
semantics-preserving because the trap-on-absent contract carries over
verbatim; plain `get` deliberately does NOT rewrite (its zero-value-on-miss
would become a wild pointer read). Making that usable surfaced three
pre-existing gaps, fixed here:

- **Scalar element borrows never worked.** Both backends' ref-local
  declaration paths only recognized struct-typed aliases, so a scalar
  slot-load fell through to the plain declaration path — the C backend
  emitted `long v = <the pointer>` and clang rejected it outright; the
  aarch64 backend stored the pointer into a scalar local and read garbage.
  Both gates now admit slot-load initializers for any element type
  (`src/build_c/build_declaration_node.ts`,
  `src/build_aarch64/build_declaration_node.ts`).
- **Scalar writes through an element borrow re-pointed instead of storing.**
  The C backend's ref-local reassignment branch unconditionally emitted
  `v = &rhs`; for a slot borrow that strands the alias (and cannot even
  compile — `&` of an rvalue). Slot-borrow locals are now tracked
  (`ref_slot_vars`) and a scalar store lands in the slot (`*v = rhs`); the
  aarch64 backend already wrote through. String values are rejected at the
  checker (`ref string` element borrows have no safe store convention —
  write-through would need the strdup-and-free-old slot discipline).
- **Element borrows of non-destroy-bearing elements were unpoliced.**
  `borrow_owner_of` only rooted a borrow at the container when the element
  was a destroy-bearing struct (`is_element_load_pure_borrow`), so `ref int
v = map.get_or_panic(k)` recorded no owner and `map.set(...)` after the
  lookup did not invalidate it. The checker-rewritten slot-load stamp now
  roots the borrow for every element type
  (`src/check/utils/borrow.ts`).

Six runtime/emission tests in `test/map_get_ptr.test.ts` (both backends,
audit on: alias write-through visible via `get`, compound assignment,
struct-value zero-copy aliasing, trap shape, string rejection, borrow
invalidation, and the emitted one-probe body); the full suite (522 files,
both backends) passes with no new failures.

**Measured.** Shape micro-benches, n from argv, Apple Silicon, best-of-5
plus interleaved rounds, audit off, identical outputs:

- _The borrow shape_ — 20M reads of `Map<int, Rec>` (`Rec`: `List<int>` of
  3 elements + int), hit path only, owning spelling (`var Rec r = …`) vs
  element borrow (`ref Rec r = …`):

| Backend | owning read | element borrow |        Δ |
| ------- | ----------: | -------------: | -------: |
| C       |       0.51s |          0.01s |    −98%* |
| aarch64 |       1.05s |          0.22s | **−79%** |

\* The C number is the optimizer collecting on the elision: once the loop
is copy-free, clang -O2 folds the invariant fields (the whole loop reduces
to the accumulator). The aarch64 number is the honest per-read cost: the
owning read pays probe + `load_T` (struct copy + fresh `List` init + slab
malloc + memcpy + displaced destroy ≈ 2 mallocs + 2 frees per read); the
element borrow pays the probe.

- _The probe-fusion shape_ — 200M hit-lookups on `Map<int,int>` (1024
  entries), `has` + `get` vs the fused single probe (`get_or`):

| Backend | has + get | fused |        Δ |
| ------- | --------: | ----: | -------: |
| C       |     0.18s | 0.17s |    ~flat |
| aarch64 |     3.28s | 1.72s | **−48%** |

The C backend is flat because -O2 already fused the pair for free: both
methods inline into the caller and GVN eliminates the second probe's
loads. The aarch64 backend issues real calls, so the second probe was real
work.

- _The standard suite_ — lru (the bench this item was booked against) is
  **flat on both backends** (C 0.86 → 0.85s, aarch64 1.80 → 1.79s at the
  measurement size `1000 20000000`; outputs identical). Its `get` is
  miss-dominated (~10% hit rate at size 1000 over a 10000-key space), so
  both spellings probe once; the win only exists on hit-heavy put paths,
  which are a minority of its loop. The bench now uses the fused spelling
  anyway (`get_or(key, -1)`) — the double probe is gone from the source,
  and the probe-fusion shape above receipts what that is worth when hits
  dominate.

**The read-position tranche (landed Nov 2026).** The element borrow
extended from the explicit `ref` binding to the two remaining victim
positions, with a discipline that keeps the elision invisible or absent,
never behavior-changing:

- **The `for of` position.** `for x of list`'s desugared binding
  (`const x = list.at(__idx)` — an owning read per iteration) is stamped
  `is_ref_binding` when the shape admits it, so the checker's element
  borrow rewrite lowers it as `List_T_slot_ptr` and the loop variable
  aliases the slot: a container-bearing struct element stops paying the
  per-iteration deep copy (fresh container init + slab malloc + memcpy
  per container field, plus its teardown). Gates, all decided at desugar
  time against today's semantics: the container exposes `slot_ptr`
  (List/StableList monos — the same probe the ref binding uses), the
  element is a concrete non-class/non-simple/non-generic value struct
  (strings keep the owning load — no safe store convention; scalars have
  no copy to elide; generics defer), and the body never references the
  iterated container and declares no nested function (a mutating or
  capturing body keeps the copy). Reads see the same values, writes
  through the binding stay rejected (the binding is a READ alias —
  `read_only_borrow` carves it out of the A3 mutation rule so
  "Assignment to const" fires exactly as before), and `mv x` outcomes are
  identical (the push copy reads the slot vs the iteration copy).
- **The expression-temp position.** The `_recv_N` receiver hoist
  (`check_access_node`) — which already materialized
  `build_norm(units).length` as an owning const temp — now hoists a slot
  ALIAS when the hoisted call is a slot-borrowable element read
  (`xs.at(i).field`, `m.get_or_panic(k).field`): the call is rewritten to
  the slot primitive at hoist time (the checked contract is identical, so
  the rewrite is verification-neutral), the temp becomes a ref local, and
  the field reads dereference it. The alias is policed by a per-statement
  registry (`hoisted_element_borrows`, shared through clone_status so a
  branch or lambda body reaches it): any `ref self` call rooted at the
  temp itself (a chained mutation, `xs.at(0).tags.push(..)`) or at its
  container later in the same statement (`f(xs.at(0).id, xs.pop())`)
  REVERTS the decl to the owning temp — restoring the copy semantics an
  owning read had, so the mutation writes a copy exactly as it did before.
  Reverting is safe post-check: both forms share the temp's name and type,
  so reads already checked stay valid, and the build picks the form up
  from `is_ref_binding`.
- **A pre-existing C-backend bug fell out and is fixed**: a slot-load
  alias whose call carried a hoisted computed key
  (`m.get_or_panic(k % n).field`) emitted the key temp mid-expression
  (`T *x = long t = ...;` — invalid C, the program did not compile) —
  main@0bdc2c38 reproduces it. The ref-local arm now surfaces the
  initializer's hoisted temps before the declaration line
  (`src/build_c/build_declaration_node.ts`).
- Still excluded by design: scalar and string elements (nothing to elide /
  no safe store convention), `at_or` spellings (not slot-borrowable),
  call-containing iteration chains (the existing desugar guard), and
  arrays (their iteration has its own ref machinery). The pre-existing
  invalidation gaps for element borrows — a `ref`-argument call and a
  container reassignment between alias creation and read — are recorded in
  FOLLOWUP.md; the new positions inherit the explicit-binding exposure,
  they do not widen it.

Fourteen tests in `test/element_borrow_reads.test.ts` (both backends, audit
on) pin the runtime shapes (for-of reads over List/StableList/param
containers, the mutating-body reference gate, temp reads, the chained-
mutation revert, the Map value temp, the unchanged const-write rejection)
and the emitted code (the loop-bound `slot_ptr` with no `List_T_at` in the
loop, the string/mutating-body copy forms, the alias deref, both revert
forms); the full suite (542 files, both backends) passes — the
zero-semantic-change claim across the corpus.

**Measured.** Shape micro-bench — `bench/nomen/element_borrow_reads.nm`:
n Outer elements built (each owning a two-element `List<string>`), then
Shape A = `for o of outers` field/container reads and Shape B =
`by_key.get_or_panic(i).n` (a bare-local key — a computed key hits the
pre-existing C bug above), n from argv, Apple Silicon, 7 interleaved
rounds, medians, audit off, release builds, identical outputs before/after;
"before" binaries built from a HEAD worktree. Per read the elided work is
exactly the tranche's promise: the owning load (a fresh `List` init + slab
malloc + memcpy, two strdups, the struct copy, and the temp teardown ≈ 3
mallocs + 3 frees) becomes the probe plus a dereference.

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| C       |           1.22s |          0.83s | **−32%** |
| aarch64 |           1.53s |          1.07s | **−30%** |

The emitted diff receipts it: the for-of binding is
`struct Outer *o = List_Outer_slot_ptr(&outers, __for_idx_o);` (no
`_mv_owns_o`, no per-iteration `List_string_destroy`), the Map temp is
`struct Outer *_recv_9 = Map_int_Outer_get_ptr(&by_key, i2);` +
`_recv_9->n` (before: the `Map_int_Outer_get_or_panic` value temp with its
teardown), and the aarch64 text holds no `bl List_Outer_at` at all.

- _The standard suite_ — flat on both backends (medians, interleaved,
  outputs identical): json-serde `bench/sample.json 50000` 0.24 → 0.25s C /
  0.47 → 0.47s aarch64, binarytrees 18 1.40 → 1.41s C / 1.81 → 1.80s
  aarch64, lru `1000 20000000` 0.87 → 0.88s aarch64, nsieve 12 0.12 →
  0.12s aarch64. No bench hot loop iterates a container-bearing struct or
  reads an expression temp through these shapes yet.

**Remainder.** The struct-`view` half of the original item: a
`view Outer` value with field access through it (the (ptr, len) view
representation covers flat data — strings and scalar arrays — but not
struct fields, and the borrow rules for nested container-field reads
through a view are undesigned). That is a language-design item of its own;
everything the slot-borrow family can reach is landed.

## 5. Json ownership copies — LANDED (Oct 2026)

**What landed.** The two zero-copy ownership paths the item asked for, in
`core/System/Text/JsonTree.nm` (callers in `Json.nm`):

- **`take_text(idx, ref StringBuilder)` — the zero-copy store.** `to_string`
  is a take (the builder hands its heap buffer over and resets), and a
  fresh-call RHS stored into an owning struct's string field is the one
  zero-copy store shape both backends already lower (the C backend's
  `is_owned_heap_temp` arm emits the call as the field's initializer; the
  aarch64 backend's `last_result_is_heap` skips the strdup and stores the
  pair raw). So `n.text = sb.to_string()` inside the method moves the
  builder's buffer straight into the node: the parse shape's
  "builder malloc → copy malloc → temp free" becomes "builder malloc".
- **`get_text_view(idx) -> view string` — the zero-copy read.** A
  self-rooted (ptr, len) borrow over the node's text (the `slice` re-rooting
  convention), which the serializer's `sb.append_string(tree.get_text(n))`
  sites now take as `sb.append_string_view(tree.get_text_view(n))` — the
  per-read `.copy()` malloc + memcpy + free is gone from
  `json_ser_pairs`/`json_ser_value`.

`set_text` keeps the plain-string API (one owned copy of the argument). The
item's `mv`-param spelling was tried first and **does not work**: both
backends strdup'd anyway, because the D3 string-ownership convention makes
`mv string` arguments caller-owned borrows (the caller frees its hoisted
temp after the call — `build_function_call_node.ts`'s string-arg gate — so
the callee's field store must copy to own anything), and the spelling
regressed the copy primitive itself (tracked-length `string_copy` became a
strlen-rescanning `_strdup`). The take-shaped method delivers the same
elision from inside the convention. Thirteen json tests pass (the parse and
stringify suites exercise both paths through `Json.parse`/`stringify`,
audit on, plus two new tests pinning `take_text` and `get_text_view`
directly); the full suite (522 files, both backends) passes.

**Measured.** `bench/nomen/json-serde.nm` (parse + re-stringify cycles, n
from argv, Apple Silicon, interleaved rounds, audit off, byte-identical
outputs on both backends — sample.json, an escapes/unicode edge doc, and a
string-heavy 8000-key doc):

- _The standard suite_ — `bench/sample.json`:

| Backend | n = 5000 (median) | n = 50000 (median) |        Δ |
| ------- | ----------------- | ------------------ | -------: |
| C       | 0.05s → 0.04s     | 0.50s → 0.39s      | **−22%** |
| aarch64 | 0.08s → 0.07s     | 0.78s → 0.69s      | **−12%** |

- _The ownership shape_ — 8000 string keys/values per document (every node
  pays a text store + a text read), 5000 parse+serialize passes:

| Backend | before | after  |        Δ |
| ------- | ------ | ------ | -------: |
| C       | 9.49s  | 7.04s  | **−26%** |
| aarch64 | 13.40s | 11.68s | **−13%** |

Per parsed string/key the elided work is exactly the item's promise: the
copy malloc, the temp free, and (on serialize) the read-copy malloc + free
are gone — 3 mallocs + 2 frees per node become 2 + 1. The emitted code
receipts it: `JsonTree_take_text` is `bl StringBuilder_to_string` + raw
pair store + displaced free (no `_strdup`) on aarch64, and
`StringBuilder_to_string(sb)` as the field initializer (no
`nomen_str_dup`) in C; `JsonTree_get_text_view` returns the `nomen_view`
pair both backends memcpy from directly.

**The null-seed tranche (landed Nov 2026).** The item's last per-node
allocation — the `JsonNode()` ctor's seed strdup inside `alloc_node`'s
in-place push — is gone: `JsonNode.text` is now `string?` seeded `null`.
The auto-`#init` stores the in-band zero pair (aarch64 `stp` of zeros, C
`(nomen_string){0, 0}` — no `bl _strdup`, no malloc), so a fresh node
allocates nothing, and `take_text`'s store displaces a null
(free(NULL) — a no-op under the audit wrapper and libc alike) instead of
the heap seed it had to free first. A node whose kind never carries text
(null/true/false/array/object — most nodes in a typical document) also
stops paying the seed's free at destroy. Reads keep their contracts:
`get_text` guards `== null` and returns a fresh `""` or `n.text.copy()` (the
coalesce spelling `n.text ?? ""` was rejected on the way: aarch64's `??`
yields the left pair AS-IS, so it would return a borrow of the pool's bytes
— the audit caught the caller freeing the node's text), and `get_text_view`
guards `== null` (the checker's dotted-path narrowing discharges the
post-guard slice) and answers an empty view for a never-texted node. Nullable
`string?` fields in mv structs inside containers were already
ownership-complete (the `Rule`-shaped tests: null seed, store, deep copy,
exactly-once teardown — audit on, both backends), and `JsonNode`'s size
and packed layout are unchanged (in-band null is still the 16-byte pair —
no flag word), so no container mono or prebuilt system.o layout moves.

One test in `test/json.test.ts` pins the never-texted node (`get_text`
and `get_text_view` answer ""/length 0 through the null seed, audit on);
the full suite (543 files, both backends) passes.

**Measured.** `bench/nomen/json-serde.nm`, n from argv, Apple Silicon, 7
interleaved rounds, medians, audit off, release builds, identical outputs
before/after; "before" binaries built from a HEAD worktree. Per parsed
node the elided work is exactly the seed strdup and its free — 1 malloc +
1 free (for text-bearing nodes the free was `take_text`'s displaced
reclaim; for the others the destroy's) — on top of the elisions the
tranches above already collected.

| Document                       | Backend | before (median) | after (median) |        Δ |
| ------------------------------ | ------- | --------------: | -------------: | -------: |
| `bench/sample.json`, n = 50000 | C       |          0.274s |         0.170s | **−38%** |
| `bench/sample.json`, n = 50000 | aarch64 |          0.497s |         0.424s | **−15%** |
| 2000×200-char doc, n = 3000    | C       |          2.326s |         1.881s | **−19%** |
| 2000×200-char doc, n = 3000    | aarch64 |          3.441s |         3.130s |  **−9%** |

The standard suite is flat on aarch64 (binarytrees 18: 1.834 → 1.830s,
lru `1000 20000000`: 1.711 → 1.710s, nsieve 12: 0.157 → 0.156s; outputs
identical): none of its hot loops allocates a JsonNode.

**The mv-string tranche (landed Nov 2026).** The item's last remainder —
the general transferring `mv string` parameter — is landed as a convention
change. `f(mv s)` into a `mv string p` is now the ARGUMENT-POSITION
TRANSFER the declaration position always had:

- **Caller** — the donor's heap record drops (moved set + the runtime
  owns-flag, so a CONDITIONAL call keeps its not-taken path's free); the
  donor is invalidated at check time (reading it afterwards is "used after
  mv"). A bare owned-string argument must now spell `mv` (the same keyword
  demand the class/owning-struct params carry). A donor that does not
  provably own heap — a literal, a literal-alias local, a borrow-shaped
  temp — is materialized into an owned copy at the call site, because the
  callee frees what it is handed.
- **Callee** — a `mv string` param is seeded as an owned heap string: its
  scope-exit frees the pair unless consumed, and the owns-flag keeps a
  branch-consumed param balanced. A consuming `field = mv p` store takes
  the buffer RAW (no strdup) — the field becomes the sole owner (`p` is
  marked moved; the runtime flag again).
- **Exceptions, all deliberate** (`src/build_common/string_transfer.ts`):
  `#init` params (auto or custom) keep the constructor copy convention
  (they strdup into their owning fields — `Dog("Rex")` is unchanged);
  generic bodies and their monos keep it too (their `mv T` params were
  checked against `T` — `Buffer<T>.store(i, mv T value)` may forward the
  same value twice); nullable `string?` params keep it (the in-band null
  makes "owns a buffer" conditional).
- **The library consumer** — `JsonTree.set_text` is now
  `(ref self, int idx, mv string text)` with `n.text = mv text`, so the
  pool takes a caller's buffer with no copy anywhere; `set_text(n,
s.copy())` is the keep-the-original spelling. `take_text` (the builder
  take) is unchanged.
- **The spawn env** packs a `mv string` argument RAW and owns nothing (the
  wrapped callee's param teardown frees it), instead of duplicating and
  freeing alongside the callee.
- A pre-existing HEAD bug fell out: an aarch64 `set_text` call whose
  argument is a CALL (`set_text(0, make(i))`) panicked at runtime; the
  reworked hoisted-argument transfer path builds it correctly.

Thirteen tests in `test/mv_string_transfer.test.ts` (both backends, audit
on) pin the transfer shapes (field store, literal materialization,
unconsumed-param free, conditional owns-flag, param forwarding, plain-read
copies, keep-with-copy, take composition) and the check-side rules
(used-after-mv, double move, bare-borrow-param rejection, missing-keyword
demand), plus the emitted no-dup store; the full suite (544 files, both
backends) passes.

**Measured.** `bench/nomen/mv_string_transfer.nm` (the box-store shape —
one source builds on both the pre- and post-convention compiler: a
producer's fresh string transfers into a `mv string` param, whose
`field = mv p` store takes it raw), n from argv, Apple Silicon, 7
interleaved rounds, medians, audit off, release builds, identical outputs
before/after; "before" binaries built from a HEAD worktree. Per iteration
the elided work is exactly the item's promise: the callee strdup at the
store and the caller's post-call temp free become one raw store (2 mallocs

- 2 frees per store become 1 + 1 — the producer's allocation IS the store).

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| aarch64 |          0.254s |         0.193s | **−24%** |
| C       |          0.175s |         0.096s | **−45%** |

The emitted diff receipts it: `nomen_str_dup(s)` at the store becomes the
bare `s`, the caller's `free(_param_N.ptr)` becomes `_mv_owns__param_N = 1`
(the flag-guarded free skips), and the field's owner frees the transferred
pair at its scope exit.

## 6. In-place store: the `set`/`insert`/`add`/`alloc` siblings — LANDED (Oct 2026)

**What landed.** The in-place construction guarantee extended from push to
container STORES: `lst.set(i, f(x))`, `buf.set(i, f(x))`, and
`map.set(k, f(x))` where the value argument is a direct call of the element
type now construct straight into the destination slot — no `_param_N` temp
home, no callee-side deep copy at the store, no temp free at scope exit. The
checker stamps the call (`in_place_push_index` re-used for the value
argument, plus a new `in_place_store_kind` naming the slot primitive,
`src/check/check_function_call.ts`); the value-argument quality gate is the
push one verbatim (`in_place_call_ok` — body-bearing callee, no by-ref
plumbing, single use, bare-local receiver; method-call value arguments keep
the hoisted path because the receiver could alias the container, the same
rule as push). Scalars keep the hoisted lowering — nothing to elide.
Evaluation order is preserved end to end: the index/key arguments keep their
ordinary lowering and precede the value, so Map's probe sees the key before
the construct begins.

- **Slot primitives.** List/Buffer-shaped containers address the destination
  with the existing `slot_ptr(i)`; the splice reclaims the DISPLACED value
  through the slot itself (the destroy half of replace: a string slot's
  displaced pointer is freed and the pair zeroed; an owning value struct's
  displaced value runs `T_destroy` guarded on the `_vt` constructed stamp —
  grown-but-unwritten and moved-out slots are zeroed; trivially-destructible
  elements need nothing), then constructs into the slot. Map needed a new
  core primitive: `Map.set_slot_ptr(key) -> ptr TV`
  (`core/System/Map.nm`) runs set's whole preamble (alloc-if-empty,
  rehash-at-load-factor) and probe with the KEY, does the insert
  bookkeeping (mark used, store key, bump length) or the displaced reclaim
  via a new `Buffer<T>.destroy_at(i)` / `ClassBuffer<T>.destroy_at(i)`
  (the destroy half of replace, no copy, specialized per element kind by
  both backends like `replace`), and returns the VALUE slot's address.
  INTERNAL, like every slot primitive — the raw pointer must not cross the
  library boundary, and the caller must overwrite the slot before it is
  read or destroyed again (both paths overwrite immediately).
- **C backend** (`src/build_c/build_access_node.ts`): the splice emits
  `{ T* _nomen_islot = <prim>(&recv, <early args>); <reclaim>;
*_nomen_islot = <constructing call>; }` — the constructing call as the
  slot assignment's RHS, exactly the lowering the push splice's in-place
  append-slot assignment already used for ctor arguments.
- **aarch64 backend** (`src/build_aarch64/build_in_place_push.ts`,
  `build_in_place_store`): the slot address lives in a FRAME SLOT (a `bl`
  inside the constructing call cannot invalidate it), the earlier
  arguments park in their own frame slots while the primitive call runs,
  and the construct re-uses push's `construct_into_frame_slot` — fat
  string pairs store raw (x0/x1), value structs take the sret preset
  window (`call_x8_preset`/`call_x8_slot_offset`, re-preset per argument).

`List.set` with string and value-struct elements (including across growth),
`Buffer.set`, Map insert + replace paths (including across rehash growth),
and the not-taken shapes (scalars, method-call value arguments,
`set_or_panic`, the `mv p` donor form) are pinned by seventeen tests in
`test/in_place_store.test.ts` (both backends, audit on); the full suite
(524 files, both backends) passes.

**Measured.** Shape micro-benches — 2048×1024 replace-stores (2M total) into
a K=1024 container seeded then overwritten in a loop, n from argv, Apple
Silicon, best-of-5 plus interleaved medians, audit off, release builds,
identical outputs:

- _The pure store shape_ — constant payload, so the only per-store work is
  the elidable copy dance (temp home + callee-side deep copy + temp free)
  versus construct-into-slot:

| Shape                       | Backend | before | after |        Δ |
| --------------------------- | ------- | -----: | ----: | -------: |
| `List<Rec>.set` (mv struct) | C       |  0.14s | 0.07s | **−50%** |
| `List<Rec>.set` (mv struct) | aarch64 |  0.16s | 0.07s | **−56%** |
| `Map<int, string>` replace  | C       |  0.11s | 0.04s | **−64%** |
| `Map<int, string>` replace  | aarch64 |  0.14s | 0.05s | **−64%** |

- _With a realistic producing call_ (per-store `f(x)` allocates: a string
  interpolation + the producer's strdup, which both lowerings pay):

| Shape                       | Backend | before | after |        Δ |
| --------------------------- | ------- | -----: | ----: | -------: |
| `List<Rec>.set` (mv struct) | C       |  0.65s | 0.58s | **−11%** |
| `List<Rec>.set` (mv struct) | aarch64 |  0.68s | 0.59s | **−13%** |
| `Map<int, string>` replace  | C       |  0.64s | 0.55s | **−14%** |
| `Map<int, string>` replace  | aarch64 |  0.65s | 0.55s | **−15%** |

Per store the elided work is exactly the item's promise: the `_param_N`
temp's malloc, the `set` callee's deep copy (a second strdup per string
field + struct memcpy), and the temp's scope-exit free — 2 mallocs + 1 free
per store become 1 malloc (the producer's own allocation, which is the
store). Map additionally stops paying replace's second probe bookkeeping on
the replace path (the splice's `set_slot_ptr` fuses probe + reclaim).

- _The standard suite_ — flat on both backends (json-serde 0.04/0.07s,
  binarytrees 1.39/1.81s, nsieve 0.12/0.15s; lru at the measurement size
  `1000 20000000` 0.85 → 0.85s C, 1.74 → 1.75s aarch64; outputs
  byte-identical): no bench hot loop stores a direct call result yet. lru's
  `put` is scalar-valued — nothing to elide by design.

**Not taken.** `insert`/`add`/`alloc` siblings (`Arena.alloc(f(x))`,
`StableList`'s staged append) keep their lowering this tranche — their slot
acquisition is not a single addressable primitive yet. `Array<T>.set`
remains on item 17's list. The `mv p` donor spelling for `set`
(`var p = f(x); lst.set(i, mv p)`) deliberately keeps the ordinary (sound)
transfer — it is not part of the guarantee. A user mv struct as a Map VALUE
type is unreachable in-source today (declaring `Map<K, SomeStruct>` poisons
every later `SomeStruct(...)` ctor call — pre-existing, FOLLOWUP.md), so
the Map receipt is taken on string values; struct-valued Maps will pick
the win up when the poisoning is fixed.

**The add/alloc siblings (landed Nov 2026).** The `insert`/`add`/`alloc`
family takes an owned `mv T value` and stores it into a FRESHLY grown slot —
a shape whose destination is either value-dependent (Set's probe compares
the value itself) or carries op-specific post-steps (Arena's handle,
LinkedList's links), so the `set` tranche's construct-into-the-slot splice
does not generalize. The elision that does is the transfer store: the callee
already OWNS the argument (the `mv T value` parameter), so the slot can TAKE
its bytes instead of deep-copying them. `Buffer<T>.store_take` (the new
INTERNAL primitive, `core/System/Buffer.nm`) byte-moves the value into the
slot and ZEROES the caller's storage — the buffer becomes the sole owner and
the caller's own teardown frees nothing. On both backends a value-struct
parameter arrives as a POINTER to the caller's storage, so the zeroing lands
on the producer's temp (or the donor's local). The generic bodies pick the
arm through a new per-instantiation constant, `T_IS_VALUE_STRUCT`
(`src/check/check_function_call_node.ts` — substituted and dead-arm-folded
exactly like `T_NEEDS_STRDUP`/`T_FAT`):

- **`T_IS_VALUE_STRUCT` true** — `Set.add`, `LinkedList.add`, `Arena.alloc`,
  `Map.set`'s insert path (key and value), `List.push`, and
  `Buffer.store_in_slab` (StableList's chunk tail) move the value in.
- **false** — strings keep the deep-copying `store` (their fat pair arrives
  by VALUE, so a take would zero only the callee's copy and leave the
  caller's buffer shared), classes/traits keep the pointer store, scalars
  keep the plain store, and enums/`#init` are unchanged.

The `mv p` donor spelling's callee path picks the same take up (the producer
form is stamped in place, as before).

Runtime+audit tests in `test/in_place_add.test.ts` (both backends) pin the
LinkedList/Map insert shapes, the string/scalar arms, and the emitted bodies
(`Buffer_Rec_store_take` in the add/push/store_in_slab monos, the
deep-copying `Buffer_string_store` in the string mono); the full suite (544
files, both backends) passes. Two pre-existing "field of a call-result
struct" bugs surfaced while shaping the tests — a double free on
`container.at_or(i, fallback).name` (`at_or` was missing from the
borrow-accessor family) and a C compile failure on
`map.get_or(k, make(0)).n` (a hoisted argument emitted inside its receiver
temp's initializer) — and have since been fixed (`test/call_result_field_read.test.ts`);
the Arena value-struct residual that keeps `test/arena.test.ts`'s
counterpart skipped is noted in FOLLOWUP.md (the take arm is already in
place for when it lands).

**Measured.** `bench/nomen/in_place_add.nm` — n iterations of
`l.add(make(i))` into a `LinkedList<Rec>` plus `m.set(i, make(i))` into a
`Map<int, Rec>` (`Rec`: string + int; the producer interpolates
`"v\{i}"`, two mallocs both lowerings pay), n from argv, Apple Silicon, 7
interleaved rounds, medians, audit off, release builds, identical outputs
before/after; "before" binaries built from a HEAD worktree. Per add/insert
the elided work is exactly the item's promise: the callee store's strdup
and the caller's temp free (2 mallocs + 2 frees per iteration become 1 + 1).

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| aarch64 |          0.349s |         0.313s | **−10%** |
| C       |          0.222s |         0.181s | **−18%** |

The emitted diff receipts it: `Buffer_Rec_store(&self->values, idx, value)`
becomes `Buffer_Rec_store_take(&self->values, idx, value)` (a byte move +
source zero), and the caller's temp-field free disappears.

## 7. Enum payload in-place construction — LANDED (Oct 2026)

**What landed.** The in-place construction guarantee extended to enum payload
arguments: `Result.ok(parse(line))` constructs the producing call straight
into the payload slot instead of hoisting a `_param_N` temp that the case
store then strdups/struct-copies in. The checker stamps a case construction
whose argument is a direct call of the payload type
(`in_place_payload_indices`, `src/check/utils/enum_mono.ts` — the same
callee-quality gate the in-place push stamps use: body-bearing callee or a
payload-struct ctor, no `ref`/override/spawn shapes, argument trees
admissible for the preset window), and the string hoist
(`hoist_case_string_arg_temp`) skips stamped indices.

- **aarch64** (`emit_enum_payload_arg_store` gains the `in_place` arm,
  `src/build_aarch64/build_access_node.ts`): a string payload stores the
  produced (ptr, len) pair RAW when the call's result is a fresh heap
  allocation (the `last_result_is_heap` signal — the same discipline the
  assignment lowering stores under) and falls back to the strdup'd owned
  copy when it is not (a borrow/rodata pair must not be claimed — the
  payload free would free foreign storage). A multi-word value-struct
  payload spills the payload's frame address and presets it as the sret
  destination via the existing `call_x8_preset`/`call_x8_slot_offset`
  window (the in-place push protocol verbatim — the argument build
  re-presets after every nested `bl`), so the callee writes the slot
  directly; the sret temp home and the struct copy disappear. A ≤8-byte
  struct payload keeps the width store (no temp exists to elide).
- **C** (`build_enum_node.ts`, both construction sites): a stamped
  construction calls an `<Enum>_<case>_init_take` variant of the case ctor
  that assigns string payloads RAW (the C convention strdups every string
  return, so any direct call's buffer is a fresh heap allocation the
  caller owns — the take claims it). The variant is discovered at the
  construction site and buffered to file scope like `box_clone_definitions`
  (C may not nest a definition in the body being emitted); unstamped sites
  keep `_init`, so both variants coexist and nothing is double-owned.
- **The stamp is whole-site for string payloads**: a case whose string
  payloads are not ALL direct calls is stamped not at all — the C take
  variant claims every string argument, so a hoisted temp or a literal at
  the same site would be double-owned. Method-call arguments
  (`seed.copy()`) keep the hoisted path, the same exclusion the push
  stamps carry. Class/trait payloads ride as bare handles and scalars
  store their width straight from the producing call's register — nothing
  to elide, no stamp.

Ten tests in `test/enum_in_place_payload.test.ts` (both backends, audit on)
pin the runtime shapes (both spellings, the borrow fallback, struct
payloads, mixed lists, the whole-site rule, return/argument positions) and
the emitted code (the C `_take` body's missing strdup and the aarch64 raw
pair store / sret preset); the full suite (525 files, both backends) passes.

**Measured.** Shape micro-benches — 3×2M constructions per shape, n from
argv, Apple Silicon, best-of-5 plus interleaved medians, audit off, release
builds, identical outputs:

- _The pure shape_ — the payload's producer is the cheapest owned-value
  producer (a seed string's `.copy()` behind a plain function — one strdup;
  a constant-payload ctor), so the elidable copy dance dominates the loop.
  One binary runs both shapes back to back (3×2M string-payload + 3×2M
  struct-payload constructions). Measured on aarch64: the C backend's -O2
  folds the whole pure loop (malloc/free pairs elided) before AND after —
  the optimizer collects the same elision, there is no honest number to
  take (the item-4 footnote again).

| Shape                                       | Backend | before | after |        Δ |
| ------------------------------------------- | ------- | -----: | ----: | -------: |
| `Res.ok(make())` + `RecRes.found(Rec(...))` | aarch64 |  0.51s | 0.28s | **−45%** |

- _With a realistic producing call_ (per-construction
  `"item\{i}"` interpolation: two snprintf passes + a malloc, which both
  lowerings pay), 3×2M string-payload + 3×2M struct-payload constructions:

| Backend | before (median) | after (median) |       Δ |
| ------- | --------------: | -------------: | ------: |
| aarch64 |           3.30s |          3.08s | **−7%** |
| C       |           2.96s |          2.93s |   ~flat |

Per construction the elided work is exactly the item's promise: the string
shape's `_param_N` temp home, the case strdup (a second malloc + memcpy),
and the temp's scope-exit free — 2 mallocs + 2 frees become 1 + 1 (the
producer's allocation IS the payload); the struct shape's sret temp home and
the payload struct copy disappear (the callee writes the slot). The emitted
code receipts it: the aarch64 ok-loop is `bl make` + two pair stores (no
`bl _strdup`), and the C construction is
`Res r = Res_ok_init_take(make(i))` with the take body's bare assignment.

- _The standard suite_ — flat on both backends (json-serde 0.06/0.04s,
  binarytrees 1.82/1.39s, lru 1.74/0.84s, nsieve 0.04/0.03s at the
  measurement sizes; outputs byte-identical): no bench hot loop constructs
  an enum case from a call payload yet.

**Remainder.** Method-call payload arguments (`Res.ok(seed.copy())`) keep
the hoisted lowering — extending the stamp to `access`-wrapped calls needs
a per-argument heapness story on C (the take label is per-call, so a mixed
site would need the classifier, not the checker, to pick it). (Struct
payloads with string fields used to hit a pre-existing ownership gap — the
enum teardown never freed a struct payload's heap fields — but the teardown
and deep-copy arms landed, 2026-10-31, so those payloads are now balanced
end to end.) The donor spelling (`var p = make(i); var Res r =
Res.ok(mv p)`) keeps the ordinary mv transfer, as in every prior tranche.

## 8. Regex/String O(n²) accumulators — LANDED (Oct 2026)

**What landed.** All three per-byte accumulator shapes from the item:

- **`Regex.match`** (`core/System/Text/Regex.nm`): the accumulator is gone.
  The loop always broke after the first match, so `match_result` was
  definitionally the matched span — the per-byte
  `match_result = match_result + "\{input.at(j)}"` (one interpolation malloc
  PLUS one whole-accumulator re-copy per matched byte, O(L²) in the span)
  is now one `input.substring(i, end)` owned copy, the same shape
  `captures`/`find` already used. `match_ci` picks the win up through the
  shared body.
- **`Regex.replace_all`**: literal bytes between matches are copied in bulk
  runs — a `run_start` cursor tracks the not-yet-copied span, each match
  emits one `append_string_view(input.slice(run_start, pos))` +
  `append_string(replacement)`, and a tail copy drains the last run. The
  old loop appended per byte both in the prefilter skip (one `append_char`
  per skipped byte) and on the no-match path (per byte when the prefilter
  is disabled, e.g. negated-class or wildcard-leading patterns). Empty-match
  bookkeeping is preserved: a zero-width match keeps its position's byte as
  the next run's start (the `x*` shape still yields `-a-b-c`).
- **`String.replace_all`** (`core/System/String.nm`): the same run-cursor
  restructure — one `append_string_view(self.slice(run_start, i))` +
  replacement per match, one tail copy, no per-byte `append_char`. The
  empty-needle guard is kept (an empty needle still never matches, so the
  result is the whole-string copy).
- **The emitted fixed-array `to_string`** (both backends' inline statement
  sequences, `src/build_c/build_access_node.ts`,
  `src/build_aarch64/build_access_node.ts`): the C body did
  `realloc` + `strcat` per element — strcat rescans the whole accumulator,
  O(n²) in the element count — and both bodies returned a broken length
  half (see the bug fixes below). The rewrite tracks a write cursor and
  capacity: one malloc sized 21 bytes/element (a scalar `to_string` upper
  bound), `memcpy` at the cursor, geometric `realloc` only when an element
  overflows, one NUL at the end, and the returned `(ptr, len)` pair carries
  the tracked length.

Two aarch64 bugs fell out of the emitted-code half (both pre-existing,
both pinned by the new tests):

- **`Array(1,2,3).to_string().length` was garbage on aarch64.** The old
  body returned only x0 — x1 held whatever the last `strcat`/reload left
  (a fresh x1 from `int_to_string`, so one-shot prints looked right; a
  `.length` in a loop read ~5e15). The cursor rewrite returns the pair
  from the tracked length.
- **char-array `to_string` had the same missing length half** — x1 held
  the last byte COPIED (`.length` of `Array('a','b','c').to_string()` was
  99 = 'c'). One `mov x1, #len` before the epilogue.

Four runtime tests in `test/string_accumulators.test.ts` (both backends,
audit on) pin the match span, the replace_all run shapes (prefilter on,
off, and the empty-match `x*` case), and the array/char `to_string`
contents AND tracked lengths; the full suite (524 files, both backends)
passes.

**Measured.** Shape micro-benches — n from argv, Apple Silicon, best-of-5
plus interleaved medians, audit off, release builds, identical outputs
checksums before/after:

- _The accumulator shapes_ — `Regex.match` = 200 matches of a 2000-byte
  `[a-z]+` span (the old loop re-copied ≈ 2 MB + 2000 mallocs per match);
  the replace_all skip-loop shape = `Regex.replace_all("zz", …)` over a
  480 KB doc (zero matches — the prefilter visits candidates only, so the
  per-byte append loop is the isolated delta); `String.replace_all` = 100
  passes over the doc with 16000 literal matches; fixed-array `to_string`
  = 10K calls of a 64-element `Array<int>`:

| Shape                                 | Backend | before |  after |        Δ |
| ------------------------------------- | ------- | -----: | -----: | -------: |
| `Regex.match` accumulator             | C       | 0.068s | 0.005s | **−92%** |
| `Regex.match` accumulator             | aarch64 | 0.101s | 0.009s | **−91%** |
| replace_all skip loop (zero matches)  | C       | 0.129s | 0.045s | **−65%** |
| replace_all skip loop (zero matches)  | aarch64 | 0.336s | 0.143s | **−58%** |
| `String.replace_all` runs             | C       | 0.115s | 0.077s | **−33%** |
| `String.replace_all` runs             | aarch64 | 0.590s | 0.356s | **−40%** |
| fixed-array `to_string` (64 elements) | C       | 0.104s | 0.074s | **−28%** |
| fixed-array `to_string` (64 elements) | aarch64 | 0.087s | 0.075s | **−14%** |

Per unit the elided work is exactly the item's promise: per matched byte,
an interpolation malloc + an accumulator re-copy (Σ = L²/2 bytes per
match) become one L-byte substring copy; per literal run, N `append_char`
calls become one memcpy; per array element, a realloc + a whole-accumulator
strcat scan become a cursor memcpy.

- _The matcher-bound shapes_ — realistic patterns WITH matches, where the
  regex engine work (probing, backtracking) is identical before/after and
  dominates: `<[^>]*>` over the tagged doc (16000 matches, prefilter on)
  is −5% aarch64 / −3% C; `[^z]x` (zero matches, prefilter OFF —
  `match_here` attempts at every position) is −2% aarch64 / flat C
  (clang -O2 already folds the append loop's bounds checks into the
  memcpy-shaped store chain). Honest reading: when the accumulator is a
  small fraction of a replace_all's total work, the win is proportional;
  the accumulator shapes above are where it lives.

- _The standard suite_ — flat on both backends (json-serde 0.070/0.043s,
  binarytrees 1.80/1.41s, lru 0.018/0.010s, nsieve 0.157/0.128s aarch64/C;
  outputs byte-identical). regex-redux at the bench size (25000_in) is
  26.0 → 25.7ms aarch64, 25.8 → 25.7ms C; at a 40× (1 MB) input,
  0.950 → 0.938s / 0.405 → 0.402s. Its substitution patterns run over
  cleaned DNA where the prefilter finds no candidates at all — the one
  run-heavy call (the header/newline strip) is a ~2ms slice of a ~1s run,
  and the count phase dominates. The bench's hot loops simply don't sit
  on the accumulator shapes; the wins are booked on the shapes above.

**Remainder.** `String.replace_first` keeps its per-byte appends — it
copies at most one run before stopping, and StringBuilder append is
amortized O(1), so there is no quadratic to remove (only the constant per
call); the same run-cursor restructure would apply verbatim if a workload
shows it. `json_parse_string`'s per-byte append loop is item 17's
scan-to-next-escape. The emitted-code rewrite assumes a scalar
`_to_string` fits 21 bytes for the initial malloc (any longer element
takes the geometric grow, so it is a size hint, not a bound).

## 9. Map/Set stored hash — LANDED (Oct 2026)

**What landed.** A fourth `Buffer<int>` per Map (`hashes` — a third per Set),
driven by the same u32 word family as `used` (`alloc_u32`/`store_u32`/
`load_u32`, 4 bytes per slot):

- **Insert** (`set`/`set_slot_ptr`/`add`): the key's `hash()` — computed once
  per call now, where `find_slot` used to hash internally — is truncated to
  u32 and stored next to the key. The replace path leaves the word alone
  (same key, same hash).
- **Probes** (`find_slot`, now taking the precomputed hash): the stored word
  is compared before the key itself, so a probed slot whose hash differs
  skips the key load and `==` entirely — on aarch64 that `==` is a
  `bl string_eq` + `bl _memcmp` when lengths match (the Swiss-table
  short-circuit; a false hash match still falls through to `==`, so the
  32-bit truncation costs nothing). On C, clang -O2 inlines the compare, so
  the win shows only where compares are real (dense tables, equal-length
  keys).
- **Rehash is hash-free and compare-free.** Instead of re-inserting via
  `self.set(mv k, mv v)` — re-hashing every key and key-comparing every
  probed slot — the loop reads each entry's stored word, derives the new
  home from it, probes `used` words only (keys arrive unique), and moves the
  entry with its word. `remove`'s backward shift reads stored words for
  `home` (no re-hash per shifted entry) and moves the word with the entry —
  `find_slot`'s short-circuit trusts it, so a stale word would strand the
  key.
- **`copy`** copies `used`/`hashes` word by word through their own
  primitives, which also fixes a pre-existing out-of-bounds read: both used
  to route through `Buffer.copy`, which is T_SIZE-aware (8-byte loads for
  `int`) against a 4-byte-per-slot `alloc_u32` slab — every copy of a
  non-empty Map/Set read past the slab's end (silently: the garbage high
  halves are never read through `load_u32`, and the over-read rarely
  faults).

Seven tests in `test/map_set_stored_hash.test.ts` (both backends, audit on)
pin the rehash growth path, the hash-move-on-shift (a colliding cluster
whose middle entry is removed), negative-key u32 truncation across rehash,
the replace path, Set growth/remove, and Map/Set copy independence; the full
suite (526 files, both backends) passes.

**Measured.** Shape micro-benches — n from argv, Apple Silicon, best-of-9
interleaved medians, audit off, release builds, identical outputs. The
"before" binaries were built from the pre-change tree (a HEAD worktree — the
probe/set shapes were rebuilt there after an initial pass accidentally
measured the new library on both sides):

- _The rehash shape_ — 2M `Map<int, int>` inserts from empty (the growth
  chain re-inserts every entry ~2×):

| Backend | before |  after |        Δ |
| ------- | -----: | -----: | -------: |
| C       | 0.022s | 0.022s |    ~flat |
| aarch64 | 0.058s | 0.046s | **−22%** |

The C backend is flat because -O2 inlines `set` and the loop is already
tight (and 22 ms is near the process-noise floor); aarch64 issues the
calls and collects the full elision — per moved entry, the `key.hash()`,
the `set` call, and the per-probe key compares are gone.

- _The string build/remove shape_ — 500k `"k{i}"` inserts (rehash-heavy),
  every 4th removed (backward shift), survivors verified via `get_or`:

| Backend | before |  after |        Δ |
| ------- | -----: | -----: | -------: |
| C       | 0.474s | 0.374s | **−21%** |
| aarch64 | 0.839s | 0.429s | **−49%** |

- _The probe shape_ — 387k fixed-width string keys, so the table sits at its
  worst-case steady load factor (~0.74, long clusters); probe strings
  pre-built, then 3.87M `get_or` lookups cycling half hits, half absent
  keys. Fixed-width keys make every probed slot's `==` a real memcmp (no
  length early-out) — exactly the compare the stored word short-circuits on
  a walk whose hashes differ:

| Backend | before |  after |        Δ |
| ------- | -----: | -----: | -------: |
| C       | 1.283s | 0.834s | **−35%** |
| aarch64 | 2.255s | 1.088s | **−52%** |

With length-diverse keys the same shape is ~flat: the `==` length check
early-outs and there is little to save. The win lives where the compare is
real.

- _The Set shapes_ — `Set<string>`: 500k adds + a verify sweep (C
  **−19%**, aarch64 **−33%**). `Set<int>`: 2M adds, 12M `has` lookups
  (5 rounds of [0,n) hits + [n,2n) misses, kept inside one capacity),
  a contiguous quarter removed (C **+8%**, aarch64 +3.6%).

  The int-keyed regression is the honest cost of the trick on keys whose
  hash is free: `int.hash()` is the identity, so the stored word is
  redundant and every probed slot pays one extra 4-byte load + compare on
  the hit path, while the rehash elision never repays it (the table is built
  once and never grows again). At the shape's ~27 ms runtime +8% is ~2 ms.
  The standard suite's int-keyed Map bench (lru) lands at +2.1% / +0.9% —
  flat within noise. String-keyed containers pay the same extra load but
  stop paying whole memcmps, which is where the design wins.

- _The standard suite_ — flat on both backends (lru `1000 20000000`
  0.88 → 0.90s C, 1.79 → 1.81s aarch64; json-serde `sample.json 50000`
  0.41/0.69s unchanged; binarytrees 18 1.46/1.85s; nsieve 12 0.13/0.16s;
  outputs byte-identical): no bench hot loop builds or probes a string-keyed
  table at density, and lru's `get_or` misses (~90% of its loop) short-
  circuit on the `used` word before any compare in both worlds.

**Remainder.** The stored word is 32 bits and lives in its own buffer, so a
probe costs two small loads (`used`, then `hashes`). Packing the tag into
the `used` word itself (Swiss-table control words — one load per probe, and
the int-keyed hit-path cost shrinks to a shift) is the next squeeze if
int-keyed hit paths ever matter more than they do today.

## 10. StringBuilder numeric appends + single-pass interpolation — LANDED (Oct 2026)

**What landed.** Two halves, both backends:

- **Numeric appends without an intermediate string.** `StringBuilder` gained
  `append_int` / `append_float` primitives, and an `append` OVERLOAD set
  (`append(int)`, `append(float)`, `append(char)`, `append(view string)`) so
  `sb.append(x)` picks the direct formatter by argument type. `append_int`
  is a hand-rolled digit loop into the buffer (no malloc, no snprintf);
  `append_float` formats with ONE snprintf into a stack scratch (360 bytes
  covers `%f` of the largest double) and bulk-copies. On aarch64 both are
  `inline` raw bodies spliced at the call site; on C they are ordinary
  functions clang inlines. `sb.append(i.to_string())` (2 snprintf passes +
  malloc + free for the int, plus the append call) becomes a few
  instructions against the buffer.
- **`int.to_string` is single-pass.** The two snprintf passes (size, then
  write) became a digit loop into a 24-byte stack scratch plus one
  malloc+memcpy — no snprintf at all, and INT64_MIN handled by magnitude
  negate (via the two's-complement wrap). This pays everywhere, including
  every numeric interpolation argument (the parse lowering wraps each
  `\{expr}` in `<T>.to_string()`). `float.to_string` likewise dropped its
  sizing pass: one snprintf into a 360-byte scratch + malloc+memcpy.
- **Interpolation is single-pass with an exact size.** `_string_interpolate_N`
  no longer runs snprintf twice over the whole result; every `%s` in the
  pattern is exactly two pattern bytes and expands to that argument's byte
  length, so `total = pattern.len - 2*N + Σ arg.len` is known from the fat
  pairs alone. One malloc, then a copy walk (literal runs verbatim, `%s`
  replaced by the next argument's bytes). That also fixes a latent
  printf-interpretation bug: a literal `%` in the source text used to be
  consumed as a format directive (`"100% of \{x}"` lost the sign); only `%s`
  is a placeholder now. The aarch64 helper is generated asm implementing the
  same count-and-copy walk.
- **Overload labels are unambiguous.** `mangled_label` now separates the
  method name from its parameter types with a double underscore
  (`Struct_append__string`): the old single `_` made an overloaded
  `append(string)` spell exactly like a distinct method named
  `append_string` — a real collision the overload set hit. Definitions only
  mangle when a method set is overloaded, and no test or raw library body
  pins the old spellings.

Nine tests in `test/string_builder_numeric.test.ts` (both backends, audit
on) pin the overload surface (int including both extremes, negative, char,
float, string), `append_int`/`append_float` agreeing with `append`,
mixed-type and high-arity (stack-passed pairs) interpolation, the literal-`%`
fix, empty arguments, and the emitted shape (no `snprintf` in
`int.to_string` or the interpolation helper; `append_int` splices). The full
suite (530 files, both backends) passes. One pre-existing perf pin needed
scoping: `test/perf_codegen.test.ts` asserted "no `msub` anywhere in the
program" for Map's mask indexing, which the new itoa legitimately uses — it
now checks `find_slot`'s own body.

**Measured.** Shape micro-benches (`bench/nomen/string_build.nm` —
old-spelling shapes that the pre-change compiler builds too;
`bench/nomen/string_append_new.nm` — both spellings in one binary for the
API isolation), n from argv, Apple Silicon, 7 interleaved rounds, medians,
audit off, release builds, outputs identical between before/after:

- _Interpolation shape_ — 1M × `"k=\{i} v=\{i * 2}"` (two int arguments,
  length accumulated so nothing folds):

| Backend | before |  after |          Δ |
| ------- | -----: | -----: | ---------: |
| C       | 0.393s | 0.078s | **−80.1%** |
| aarch64 | 0.397s | 0.084s | **−78.7%** |

Per iteration the elided work is the item's promise: the two int
`to_string`s' four snprintf passes become two digit loops, the helper's
two full-result snprintf passes become one memcpy walk, and the result
allocation is exact — per iteration 3 malloc/free pairs and 6 snprintf
calls become 3 mallocs (two argument strings + the result) and zero
snprintf.

- _Numeric append shape (old spelling)_ — 1M ×
  `sb.append_string(i.to_string())` (the intermediate string per append):

| Backend | before |  after |          Δ |
| ------- | -----: | -----: | ---------: |
| C       | 0.121s | 0.029s | **−76.0%** |
| aarch64 | 0.124s | 0.031s | **−75.3%** |

- _The overload/primitive receipt_ — the same binary, old spelling vs
  `sb.append(i)` (post-change compiler only, so the delta is isolated from
  layout drift):

| Backend | old spelling | new spelling |          Δ |
| ------- | -----------: | -----------: | ---------: |
| C       |       0.030s |       0.010s | **−66.0%** |
| aarch64 |       0.033s |       0.010s | **−69.6%** |

The new spelling drops the intermediate string allocation and the append
call entirely (the spliced digit loop writes into the builder).

- _The standard suite_ — flat except where string building is hot, with
  outputs identical: regex-redux C 0.015 → 0.013s (**−8.2%**); knucleotide
  C 0.008 → 0.007s (**−10.0%**), aarch64 0.009 → 0.008s (**−12.3%**);
  json-serde, binarytrees, lru, nsieve within ±2% on both backends.

**Remainder.** Floats still need one snprintf (no hand-rolled `%f`); the
interpolation call site still converts each numeric argument through
`<T>.to_string()` (one malloc per argument) — a writer-form call-site
lowering that appends directly into the helper's buffer would remove those,
but the exact-size helper already removed the double pass over the result.
`float32`/`ufloat*` keep their own two-pass bodies for now (same shape as
the old float).

**The writer-form interpolation tranche (landed Nov 2026).** The remainder's
call-site lowering is in: a `\{expr}` whose expression is a NUMERIC scalar no
longer routes through `<expr>.to_string()`, so the per-argument string
allocation disappears.

- **Checker** (`src/check/check_function_call.ts`, via
  `src/check/utils/interp_arg_kinds.ts`): after each interpolation argument
  is checked, a `.to_string()` wrap whose TARGET's stamped type is a bare
  numeric scalar (int/uint families, every float family — all 64-bit doubles)
  is unwrapped in place and its KIND recorded; the node's name then gains the
  per-argument kind suffix (`_string_interpolate_<arity>_<kinds>`, one of
  `s` string pair / `i` signed int / `u` unsigned int / `f` float) and the
  synthesized helper node is retitled so the builds emit the new label.
  Everything else keeps `s`: strings (a real `to_string` copy is still
  required for the owning pair), bools (`"true"`/`"false"`), chars
  (the character itself), and any container whose TYPE carries its element's
  name (`Array(1,2,3)` is `Type{ name: "int", is_array: true }`, and the
  array's `to_string` renders all elements — excluded by the `is_array` /
  `is_view` gate). All-string interpolations keep the unsuffixed name
  (`_string_interpolate_N`), so every existing shape and the system TU's
  pre-emitted arities 1..7 stay untouched; suffixed mixes are per-TU-local
  (never `.globl`, C-`static`) because the system TU cannot enumerate mixes.
- **The kind suffix rides the NAME, not the pattern** — a pattern-encoded
  kind would reintroduce the literal-`%` ambiguity the earlier tranche
  removed (`"100% d"` would become a directive). The pattern still holds one
  `%s` per argument; the helper's per-argument kind is static in its label.
- **Both helper generators** (`build.ts` for aarch64, `build_c/build_root_node.ts`
  for C) emit one helper per mix the TU calls. Each numeric argument renders
  into the helper's own frame scratch — the `append_int` digit loop (magnitude
  via the two's-complement negate, so INT64_MIN is exact; signed = one `-`
  prepended) and ONE `%f` snprintf per float into a 360-byte scratch (the
  plan's hand-rolled-`%f` exclusion) — and then EVERY argument walks as a
  (ptr, len) pair: the unsuffixed helper's copy walk, unchanged. On aarch64 a
  numeric argument consumes ONE incoming slot (raw bits in an x register —
  floats ride integer registers in the Nomen ABI), so the helper's slot map
  handles mixed widths, including a string pair straddling x7 / the outgoing
  area. Sub-64-bit int arguments re-narrow at the call site with same-width
  shifts/masks (`lsl`/`asr` pairs, `and` masks) — cross-width `sxtw x0, w0`
  shapes hide the load from the liveness model, which then deletes it.
- **C**: the mixed helper is `static` (a library mix and a user mix can't
  collide at link time), takes typed parameters (`long long` / `unsigned
long long` / `double`), and the call site casts each numeric argument.
  The aarch64 call site needs no cast (the ABI's register convention is
  already width-independent).

Six tests in `test/interp_writer_form.test.ts` pin the runtime values on both
backends with the auditor on (int/uint extremes incl. uint64 max and a
runtime-wrapped INT64_MIN, negative int8/int16/int32, uint32's 32-bit range
value, floats both signs, zero, empty string, mixed string+int+float
ordering, an 8-argument mix, a literal `%`, and computed expressions), plus
the emitted shape (mixed helper labels, typed C signatures, no
`<T>_to_string` at the call site, the digit loop and `%f` snprintf living in
the helper). The full suite (548 files, both backends) passes.

**Measured.** Shape micro-benches, n from argv, Apple Silicon, 7 interleaved
rounds, medians, audit off, release builds, identical outputs; "before"
binaries built from the pre-tranche compiler (the same source compiles on
both — it just lowers through `to_string` on the old one):

- _The int shape_ — `bench/nomen/string_build.nm`'s `interp` mode
  (1M × `"k=\{i} v=\{i*2}"`, length accumulated — the item-10 bench):

| Backend | before |  after |        Δ |
| ------- | -----: | -----: | -------: |
| C       | 0.075s | 0.030s | **−58%** |
| aarch64 | 0.080s | 0.030s | **−62%** |

Per iteration the elided work is exactly the item's promise: the two numeric
`to_string` calls' mallocs (and their digit loops) disappear — the digits are
rendered inside the helper — so 3 mallocs per iteration (two argument strings

- the result) become 1 (the result).

* _The mixed shape_ — `bench/nomen/interp_writer_form.nm`: two shapes back to
  back, 2M steps each — the int shape above, then
  `"s=\{name} i=\{i} f=\{f} n=\{neg}"` (string + int + float + negative int;
  the float keeps its one `%f` snprintf, now straight from the helper):

| Backend | before |  after |        Δ |
| ------- | -----: | -----: | -------: |
| C       | 0.560s | 0.360s | **−36%** |
| aarch64 | 0.600s | 0.390s | **−35%** |

- _The standard suite_ — flat on both the numbers and the output: A/B builds
  (identical outputs asserted), 7–15 interleaved rounds, medians — json-serde
  `bench/sample.json 50000` +0.1%, binarytrees 18 −1.1%, lru
  `1000 20000000` +0.6%, nsieve 12 −0.5%, regex-redux −0.7%. No bench hot
  loop interpolates bare numerics at scale except the shape benches above.

**Remainder.** `float32`/`ufloat*` keep their own two-pass `to_string` bodies
(same shape as the old float) — irrelevant to this lowering (floats
interpolate as doubles). Hand-rolled `%f` stays out of scope by design: one
snprintf is fine.

## 11. Devirtualization of trait calls — LANDED (Oct 2026)

**What landed.** When the concrete conformer behind a trait-typed position is
statically visible, the dispatch lowers as a DIRECT call to
`<Class>_<method>` — the same symbol the vtable slot holds — instead of
resolving through `_get_trait_func` (two dependent vtable loads + an
indirect branch on aarch64, an opaque function-pointer cast on C that
blocks inlining). The proof is checker-side, whole-function:

- **The rebind scan** (`collect_rebound_names`,
  `src/check/utils/devirtualize.ts`): once per function entry, every name
  the body REBINDS in a way that could change a binding's conformer —
  assignment targets, swap operands (both sides, plus the moved-out RHS
  source of `a = mv b swap c`), and `ref`-argument passes (the callee
  receives the caller's SLOT and may reassign it). Whole-function, not
  statement-ordered: a rebinding LATER in a loop body retypes EARLIER call
  sites on the next iteration, so no amount of in-order clearing can stamp
  calls inside a loop safely.
- **The concrete tracking** (`StackValue.concrete_struct`): set at
  declaration when a trait-typed local's initializer is a direct
  constructor call of a conforming struct (the checker stamps the call's
  `.type` with the struct name), or a `mv` from a donor that itself carries
  a known concrete, or the boxed copy of a bare value-struct donor. Names
  in the rebind set, globals (any function may rebind them — each function
  is checked against its own scan), params, and
  nullable/ref/view/array-typed bindings never carry it.
- **The stamp** (`AccessFunctionCallNode.devirtualized_class`, set in
  `check_access_node`'s trait-method resolution): only for a bare-local
  receiver, a non-generic trait and conformer, and — for the method —
  either the conformer defines it (the plain `${Struct}_${method}` label,
  not an overloaded/mangled one) or it inherits a trait DEFAULT with a body
  (`${Trait}_${method}` — the label the vtable slot holds for that
  conformer too; a bodyless trait signature has no symbol, so it keeps the
  dispatch). Both backends re-derive the mechanical facts at the site
  (struct exists, non-generic, defines the method or the default has a
  body), so stamp and lowering can't drift.
- **C** (`build_access_node.ts`): the callee expression
  `(${cast}_get_trait_func(recv, ti, fi))` becomes `Table_mix` — the
  receiver expression, argument lowering, and every wrapper around it
  (lambda-arg temps, rvalue-receiver temps, owned-receiver destroy) are the
  dispatch path's own. With the call direct, clang -O2 can finally see (and
  inline) the callee.
- **aarch64** (`build_access_node.ts`): the dispatch core
  `ldr x10,[x9] / ldr x10,[x10,#(ti+1)*8] / ldr x10,[x10,#fi*8] / blr x10`
  becomes `bl Table_mix`; the receiver setup (x0 = instance, args in
  x1..x7) is shared and unchanged.

Sixteen tests in `test/trait_devirtualization.test.ts` pin the lowering on
both backends (known class conformer, boxed value-struct conformer, `mv`
propagation, inherited trait default — direct; reassignment, loop-body
reassignment, branch reassignment, `ref`-argument pass, a bodyless trait
signature — still dispatching), the runtime results on all of those, and
the rebind scan's collection rules (unit). The full suite (529 files, both
backends) passes.

**Measured.** Shape micro-bench — `bench/nomen/trait_dispatch.nm`, four
dispatch shapes back to back (n from argv, Apple Silicon, 7 interleaved
rounds, medians, audit off, release builds; outputs identical between the
before/after binaries of each backend):

- _Shape A — tiny callee_ (`var Shape s = Square(7)` hoisted, loop body is
  only the dispatch + a multiply):

| Backend | before |  after |          Δ |
| ------- | -----: | -----: | ---------: |
| C       | 0.175s | 0.003s | **−98.5%** |
| aarch64 | 0.239s | 0.239s |      ~flat |

The C number is the optimizer collecting on the elision (the item-4/7
footnote again): with the call direct, clang inlines `Square_area` and
folds the whole loop to a closed form — before, the opaque
`_get_trait_func` indirection blocked inlining entirely and the loop paid
a predicted indirect call per iteration. The aarch64 number is the honest
dispatch-only cost: the two vtable loads issue early and hide under
across-iteration overlap, and a monomorphic indirect branch predicts
perfectly, so steady-state throughput doesn't move.

- _Shape C — realistic callee_ (a masked 12-op hash chain, `m.mix(i % 1024)`
  — the dispatch is a small slice of the iteration):

| Backend | before |  after |          Δ |
| ------- | -----: | -----: | ---------: |
| C       | 0.304s | 0.266s | **−12.4%** |
| aarch64 | 0.359s | 0.346s |  **−3.5%** |

- _Shape E — dependency-chained_ (`x = m.mix(x)` — each call's argument is
  the previous result, so the dispatch sits on the loop-carried chain):

| Backend | before |  after |         Δ |
| ------- | -----: | -----: | --------: |
| C       | 1.162s | 1.148s | **−1.2%** |
| aarch64 | 0.916s | 0.900s | **−1.7%** |

Even on the chain the loads resolve early enough to hide; the win is the
call plumbing, not latency.

- _Shape B — container dispatch control_ (`shapes.at_or_panic(k).area()` —
  never devirtualizable): flat on both backends (±0.1%), confirming the
  stamp reaches exactly the sites it proves and nothing else.

- _Shape D — the inline splice_ (`bench/nomen/trait_dispatch_inline.nm`,
  its own binary so the extra loop's register pressure cannot shift the
  other shapes; the same-shaped non-inline callee is shape A): a
  devirtualized call whose concrete method is `inline func` splices the
  body at the call site — no call instruction at all on aarch64, and clang
  inlines + folds the C loop:

| Backend |      before |  after |                              Δ |
| ------- | ----------: | -----: | -----------------------------: |
| C       |      0.004s | 0.003s |                     **−13.4%** |
| aarch64 | cannot link | 0.197s | **−18.9%** vs the shape A loop |

The aarch64 "before" cell is the bug, not a missing measurement: an
`inline` method on a trait-CONFORMING struct previously never emitted a
standalone symbol, so the struct's unconditionally-emitted vtable
referenced a never-defined label and the program failed to LINK (the
same program compiles and dispatches after this item's emission fix).
The −18.9% compares the spliced loop against the same-shaped loop with a
non-inline callee in the same compiler (`bl <Class>_area`); against the
vtable loop it is larger still.

- _Shape T — the trait-default conformer_ (`bench/nomen/trait_dispatch_default.nm`):
  `Table` inherits `Mixer.mix` (the trait's default body carries shape C's
  masked hash chain and reads a trait field), so the vtable slot holds
  `${Trait}_${method}` — the devirtualized call targets that same label:

| Backend | before |  after |          Δ |
| ------- | -----: | -----: | ---------: |
| C       | 0.475s | 0.329s | **−30.9%** |
| aarch64 | 0.479s | 0.470s |  **−2.0%** |

The C win outstrips shape C's because the inherited default's two
`self.seed` reads are themselves trait-field dispatches
(`get_${Concrete}_seed` through `_get_trait_func`): once the body inlines
at the direct call site, the whole site (call + field reads) collapses —
the emitted code drops from three `_get_trait_func` call sites to two
(the mix call is direct; the field accessors remain, as they must).
aarch64 stays near-flat for the same steady-state reason as the other
monomorphic shapes.

- _The standard suite_ — flat on both backends (json-serde 0.041/0.041s C
  +0.0%, binarytrees 1.414/1.409s −0.3%, lru 0.851/0.876s +2.9%, nsieve
  0.127/0.126s −0.2%; aarch64 0.070/0.071s, 1.817/1.827s, 1.765/1.761s,
  0.156/0.156s; outputs byte-identical): none of the benches declares a
  trait.

**The inline splice (landed with the item).** A devirtualized call to an
`inline func` method now takes the same splice the concrete-receiver path
takes (`build_inline_method`; the machine state at the dispatch point — x0
= instance, args in x1..x7 — is identical). Making that linkable required
fixing the pre-existing emission gap: an inline method that a conforming
trait DECLARES now emits a standalone body, because the struct's
per-trait vtable entry IS that method label and the table is emitted
unconditionally (a marker trait like `Viewable` declares no functions, so
its conformers' inline methods reference nothing and stay splice-only —
emitting those would grow every container mono for no linkage need).
Plain-string returns stay on the `bl` (the dispatch tail normalizes them
against the call ABI, which a spliced body does not take); four tests in
`test/trait_inline_method.test.ts` pin the link, the vtable dispatch, the
splice's emitted shape, and the runtime results.

**Remainder.** Item 11's planned scope is complete (overrides, boxed
value-struct conformers, `mv` propagation, inherited trait defaults, the
inline splice). What stays on the table by design or by other gaps:

- **Field-path receivers** — trait-typed FIELDS are rejected today ("a
  trait-typed field is not supported yet", check_struct_node), so
  `self.speaker.speak()` cannot exist as a trait dispatch; a field-path
  receiver of CONCRETE type already lowers direct. Revisit with trait
  fields (STRUCT_PLAN_3 B5 remainder).
- **Container elements** (`pets.at_or_panic(i).speak()`) would need
  element-level "every store was the same conformer" tracking, a different
  analysis from the binding-level proof here.
- **Generic traits/structs** — the direct label would need the
  monomorphized signature substitution the vtable cast performs; deferred.
- **The `ref`-argument conservatism stays by design, not because of the
  (now fixed) ref-trait write-back bug**: a `ref` argument genuinely may
  rebind the caller's local mid-function, so any ref pass must keep the
  name out of the known-concrete set.

## 12. Struct field-order / padding — LANDED (Oct 2026)

**What landed.** The three layout authorities now walk a PACKED order — each
struct's own fields sorted by alignment descending (stable within equal
alignment, so all-word structs keep their declaration order byte-for-byte):
the aarch64 offset/size walk (`layout_fields`,
`src/build_aarch64/utils/struct_layout.ts`), the C typedef member emission
(`src/build_c/build_struct_body.ts`, and the `aarch64_use_c` companion's
struct definitions in `src/build_aarch64/utils/c_companion.ts`), and the
check-side `raw_type_size` T_SIZE mirror
(`src/check/check_function_call_node.ts`). One shared module decides the
order and the exclusions (`src/build_common/struct_packing.ts`, memoized per
struct — `layout_fields` runs per field access, and the sort must not show up
in compiler time):

- **`struct.fields` itself is untouched.** The auto-`#init` binds its
  parameters positionally in field order (`Pt(1, 2)`), so permuting the array
  would silently flip every positional construction. Packing is a
  layout-order VIEW; the ctor signature, named field overrides, and
  destructuring (by name) are unchanged. `#init`'s per-field stores emit in
  packed order — independent stores, semantics-neutral.
- **The skip predicate.** Declaration order stays for: structs with ANY raw
  `#arch` body in ANY of their functions (the raw text hardcodes field
  offsets — StableList's `length @8` / `items.data @24`, StringBuilder's
  `data @8 / len @16 / cap @24`, the async family, File, Mutex, Atomic; the
  same "raw bodies are opaque" treatment scan_inline_candidates uses), tuples
  (`_Tuple_*` — positional index contract), and structs with fixed-size
  stack-array fields (the C backend emits `T name[N]` with no length header
  while the aarch64 layout sizes `8 + elem*len` — that disagreement stays
  quarantined in declaration order). Monomorphized clones carry their raw
  statements through substitution, so a generic and its monos always decide
  the same way. The System library's only sub-8 field outside raw-body
  structs is `Init.is_tty`, and `Init` has a fixed-array field — so no
  prebuilt-system.o layout changes.
- **Why descending alignment is exactly right here:** in this type system
  every type's size is a multiple of its natural alignment (scalars
  size == alignment; strings/views/structs are multiples of 8), so the
  sorted order is GAP-FREE — the aligned layout walk never inserts padding,
  C's naturally-aligned members of the identically-ordered typedef land on
  the same offsets, and the RAW unaligned cursor walks in the aarch64
  owning-buffer/destroy specializations
  (`owning_buffer_specialize.ts`, `auto_destroy.ts`) stay exact. Those
  cursor walks (collect_string_fields, collect_transfer_fields,
  emit_load_deep_copy_fields, container_data_offsets_a64,
  collect_displaced_leaves_a64, emit_borrow_carrier_owned_free,
  emit_destroy_for_array_elem) now iterate the packed list, and the four
  sites that computed offsets over filtered/declaration-order field lists
  (emit_field_destroys, emit_field_destroys_at, emit_nested_field_destroys,
  box_clone's clone_fields) compute them against the full packed layout
  while keeping their visited-set filters.
- **Nullable `_has` flags follow their field** (offset + size) in both
  backends, unchanged.

Eleven tests in `test/struct_field_packing.test.ts` (unit: sort order,
stability, the alignment mirror, the skip predicate; emission: the C typedef
member order, the aarch64 T_SIZE 32-not-40 stride fold, the ctor `strb`
offsets; runtime: field round-trips, string/List ownership through packed
offsets on BOTH backends with the auditor on, and a Map round-trip); the
full suite (532 files, both backends) passes.

**Measured.** Shape micro-bench — `bench/nomen/struct_packing.nm`: n
`Rec` pushes (word/bool/word/bool — declaration T_SIZE 40, packed 32) into a
`List`, then two field-sum read sweeps; checksum identical before/after; n
from argv, Apple Silicon, 7–9 interleaved rounds, medians, audit off, release
builds. "Before" binaries built from a HEAD worktree:

| Backend | before |  after |        Δ |
| ------- | -----: | -----: | -------: |
| aarch64 | 0.469s | 0.423s | **−10%** |
| C       | 0.188s | 0.165s | **−12%** |

Peak RSS at n = 20M: **1345 MB → 1078 MB (−20%)** — exactly the T_SIZE cut
(40 → 32 bytes per element), paid again on every push growth memcpy and read
sweep. At n = 4M (list hot in cache) both backends are flat — the win is
memory-traffic, so it lives where the container exceeds the cache.

- _The standard suite_ — flat on both backends (medians, interleaved, outputs
  byte-identical): json-serde 0.693 → 0.689s aarch64 / 0.401 → 0.397s C,
  binarytrees 1.836 → 1.831s / 1.409 → 1.424s, lru `1000 20000000` 1.697 →
  1.699s / 0.887 → 0.892s, nsieve 0.162 → 0.161s / 0.131 → 0.131s — all
  within ±1.1%. No bench struct has a sub-8-byte field (System structs with
  sub-8 fields are excluded or fixed-array), so there was nothing to pack.

**A crash fell out of the walks.** A donor-form `l.set(i, mv r)` on a
`List` of sub-8-field mv structs CRASHED on aarch64 before this change
(the unaligned cursor walks disagreed with the aligned layout for
declaration orders whose prefix sums aren't naturally aligned — e.g. a
`bool` field before a word field). The packed order is always gap-free, so
the walks are now exact and the program runs; eleven suite tests pin the
packed-ownership paths. The same shape was suspected to leak 4 allocations
on the C backend, but never reproduced — the C specializations address
fields BY NAME (the typedef order is layout-only), so alignment cannot
misdirect them; the shape is pinned ownership-clean on both backends by
`packed_donor_set_ownership` in `test/struct_field_packing.test.ts`.

**Remainder.** Trait-declared fields pack among themselves but stay AFTER
the own fields (the own-fields-first contract the per-name offset lookups
rely on), so a struct whose trait fields are words and whose own fields end
in sub-8 scalars keeps one boundary gap. Packing is per-struct, opt-out by
the raw-body/fixed-array/tuple exclusions only — a per-struct `packed`/
`declared` attribute would let raw-body structs opt in after a hand-audit of
their raw offsets. `_has` flag bytes still sit between fields (a nullable
scalar before a sub-8 field wastes bytes); grouping flags at the struct tail
would shave those, and needs the C emission to move them identically.

## 13. Variable-mode enums — PARTIALLY LANDED (Oct 2026)

GOOSE #6 asked for enums whose values pack to their variant's size instead of
every value paying tag + the largest payload. This tranche lands the
statically-known-variant half: **case-qualified types** — `Enum.case` in a
type position (`Res.ok`) names the variable-mode form of the enum — a value
that is exactly one case, stored at that case's size (tag word + the case's
payload, word-rounded) instead of tag + the largest case's payload. The
freeze-at-construction constraint is enforced by the TYPE SYSTEM rather than
a runtime check: nothing but an `.ok` construction types as `Res.ok`, so a
`Res.ok` slot can never change variant — the safety condition MEMORY.md's
tagged-union note leans on. The spelling flattens to a single-case mono enum
(`Res.ok` → `Res__ok`; double underscore so the mono's C identifiers never
collide with the base enum's tag constants `Res_err`/`Res_ok`), materialized
during check into `status.enums` + `status.types` + `root.statements` — the
same route generic monos take.

- **Parse** (`src/parse/parse_type.ts`): `Enum.case` after the base type
  name; the `?`/`[]` suffixes still apply (`Res.ok?`). Case types over a
  generic instantiation (`Option<int>.some`) are rejected with "not supported
  yet" (remainder).
- **Check** (`src/check/utils/case_enum.ts`, hooked from
  `check_type_exists`): validates the base enum + case, rejects name
  collisions (`struct Res__ok`), copies `is_owning`/`checked` (a `mv enum`'s
  monos stay move-only; a `checked` enum's stay checked), and stamps every
  case's `tag_index` = its ORIGINAL declaration index (`check_enum_node`).
  Construction coercion: when the expected type is the matching case mono,
  `check_access_node` stamps the mono type and rewrites the `Res.ok(...)` /
  `Res.ok` receiver to the mono, so both backends construct the mono value —
  the existing enum machinery (in-place push/store, match, `==`, sret,
  container monos, ownership teardown) keys off the type name and just works.
  Explicit constructor type args (`List<Item.small>()`) materialize the mono
  in `check_function_call_node`, since that path bypasses annotation
  validation.
- **Tags** (`get_enum_case_index` in
  `src/build_aarch64/utils/struct_layout.ts` plus the seven other
  tag-emission sites; `src/build_c/build_enum_node.ts`): a tag's VALUE is
  `case.tag_index ?? position`, so a mono's single case (position 0)
  stores/compares the base enum's tag — case-mono values are byte-compatible
  with base values. The C tag typedefs emit explicit values when they differ
  (`typedef enum { Item__small_small = 1 } Item__small_tag;`).
- **No conversions this tranche**: a case-mono value cannot flow into a
  base-typed slot (or the reverse) — declaration/assignment/argument/return
  positions compare type names, so the mismatch is a clean check error. Case
  types interoperate with themselves: locals, params, returns, struct fields,
  `List`/`Map`/`Set`/`Buffer` elements, `match` (exhaustiveness refines to
  the single case), and `==`.
- **A pre-existing bug fixed on the way**: C match bindings whose names are
  ObjC/C-reserved (`id`) were declared unmangled while the body referenced
  the mangled `_nomen_id`; the declaration now goes through
  `c_function_name` (`src/build_c/build_match_node.ts`). `match` on a
  multi-case data enum with a call/`pop()` scrutinee SIGBUSes on aarch64 at
  HEAD — pre-existing and unrelated (FOLLOWUP.md), so the bench and tests
  avoid that shape. (Fixed 2026-11: the call site's sret temp was sized with
  `get_struct_size`, which answers 8 for an enum name — see
  test/aarch64_regressions.test.ts "enum-with-data method return sret temp
  holds the blob".)

Sixteen tests in `test/enum_variable_mode.test.ts` (both backends, audit on)
pin the runtime shapes (int/string payloads, shorthand, same-case
reassignment, `List` push/read/`pop`, zero-payload cases, `==`, struct
fields, params/returns) and the emitted code (`Item__small_small = 1` tag,
`sizeof(Item__small)` container stride, the aarch64 frame/copy shrink); the
full suite (533 files, both backends) passes.

**Measured.** Shape micro-bench — `bench/nomen/enum_variable_mode.nm`: n
pushes + an n-read sweep, `Item { case missing; case small(int id); case big(int id, int a, int b) }`
— fixed slot 32 bytes (tag + 3 payload words) vs `Item.small` slot 16 (tag +
1). Same binary, mode from argv, n = 5M, Apple Silicon, 9 interleaved rounds,
medians, audit off, release builds, identical checksums:

| Backend | fixed (before) | var (after) |        Δ | peak RSS            |
| ------- | -------------: | ----------: | -------: | ------------------- |
| C       |        0.0432s |     0.0203s | **−53%** | 260 → 132 MB (−49%) |
| aarch64 |        0.0902s |     0.0623s | **−31%** | 260 → 132 MB (−49%) |

At n = 2M (more cache-resident): C −32%, aarch64 −26%, RSS −47%. Per element
the elided work is exactly the item's promise: half the stride — every push
slot store, growth memcpy, read load, and ownership zero is 16 bytes instead
of 32 — and the allocation halves; the RSS column is the direct receipt.

- _The before/after control_ — the fixed shape's emitted code is
  byte-identical between the pre-change compiler and this one (all four
  standard-suite sources too: json-serde, binarytrees, lru, nsieve —
  `cmp`-equal `.m`/`.s` on both backends). No existing program's emission
  changed; the win is exactly the layout the new type asks for, so the
  standard suite needs no timing table.

**Remainder.** (1) True variable-stride storage — GOOSE's "packed and
sequential" array where element _i_'s address is not `base + i × stride`
(needs a packed container family; today a case mono is a fixed-stride
container of variant-sized elements, which captures the memory win for
unknown-dimension-free uses). (2) Case types over generic enums — LANDED
(Nov 2026): `Option<int>.some`, `Result<int,string>.ok` materialize
mono-of-a-mono — the annotation's generic instantiates first
(`monomorphize_enum` → `Option_int`), then the case mono over it
(`Option_int__some`), whose single case carries the ORIGINAL declaration
index as its tag (mono cases now stamp `tag_index`; the C tag typedef emits
the explicit value when it differs from position). The parse records
`case_enum`/`case_name` and leaves the name generic;
`resolve_case_enum_type` materializes both monos and rewrites the
annotation. Construction (shorthand `.some(4)` and the explicit
`Option.some(4)` access spelling), `match` exhaustiveness, `==`, and
containers work through the existing mono machinery. Tests:
`test/enum_variable_mode.test.ts` "case types over generic enums".
(3) Base↔case conversions — LANDED (Nov 2026). case→base (the widening
half) at declaration + assignment sites on both backends: a temp of the
value's own type + a CASE-SIZE prefix copy (memcpy/struct copy) + move-zero
of the source; the displaced-payload frees run tag-guarded on the parent
layout, and the slot's own teardown is unchanged (the enum auto-free walk
keys on the declared type). base→case (the narrowing half) landed as the
EXPLICIT checked cast `r as Res.ok` — NOT an implicit assignment conversion
(that would be the language's only implicit runtime panic; every existing
runtime check is opt-in and call-site visible: the `_or_panic` family).
The cast rides the `as` machinery: a runtime tag comparison against the
case's ORIGINAL declaration index, panicking ("base to case conversion:
the value carries a different variant") on mismatch — printf+exit on C,
write+exit syscalls on aarch64 — and COPY semantics in both directions
(the `<Enum>_copy` deep copy on C, the tag-guarded in-place payload
strdups on aarch64): the source keeps ownership, no moved stamping. An
enum whose payloads have no deep-copy story (a trait/class payload)
rejects the cast at check with "use match". Remaining surface:
argument/return/container conversion sites are still type errors, and
statically discharging the check in provable flow contexts (right after a
`.ok` construction, a match arm binding) mirrors how `at`'s bounds
contract is discharged today. Tests: `test/enum_variable_mode.test.ts`
"base↔case conversions" (narrow matching-variant, mismatch panic, widen,
copy independence, non-copyable rejection). (4) A whole-enum
variable-mode type (`Shape..` in GOOSE's spelling) whose size comes from
the tag at runtime — the other half of #6.

## 14. Buffer word pairs for T_SIZE ≤ 16 — LANDED (Oct 2026)

**What landed.** Buffer's T_SIZE-aware slot family — `load`/`store`/`replace`/
`move`/`shift`/`load_from`, the load_T/store_T pair behind every container
`.at`/`set`/`pop` — gained a word-pair arm: for `8 < T_SIZE ≤ 16` the slot
copy is one `ldp`/`stp` pair where the width dispatch used to fall into
`bl _memcpy` (plus `bl _memset` for move's/shift's slot zero). The dispatch is
written for the folder (`cmp x3, #16 / b.gt <memcpy>` over the existing ≤ 8
width match), so after monomorphization each element kind gets straight-line
code: T_SIZE 16 splices as `lsl` stride + pair move with the dispatch and the
memcpy tail left unreachable, scalars keep the width-matched loads unchanged,
and > 16 keeps the calls.

- Since struct sizes round to 8 bytes, the new arm serves exactly the
  16-byte class (VT word + one field word) and ≤ 16-byte enums-with-data.
- The mv-owning specializations (`emit_owning_store_T`/`replace_T`/`load_T`/
  `shift_T`, inline and standalone —
  `src/build_aarch64/utils/owning_buffer_specialize.ts`) take the same pair
  through a generation-time gate (`emit_slot_pair_copy`, `T_SIZE <= 16`). The gate is reachable only
  for the vt + 8-byte-Box shape: the smallest previously-possible owning
  element (`has_string_fields || struct_needs_destroy`), since a string field
  already puts an element at 24 bytes. Enum specializations stay memcpy-only
  (an owning enum always carries a string payload, ≥ 24).
- `modify`'s staging copies keep memcpy (the staged copy feeds a closure
  call; the item is the load/store family). StableList's chunk moves
  (`push_tail`, `load_tail`'s delegation) are unchanged.
- **C untouched, verified:** the `#arch: c` bodies and the C backend are
  byte-identical before/after (all four standard-suite C sources `cmp` equal)
  — clang -O2 already inlines small struct assignments, as the item
  predicted.

**Measured.** Shape micro-bench — `bench/nomen/buffer_word_pairs.nm`: a
`List<Pair>` of 16-byte elements (`Pair` = VT + one int), n from argv, Apple
Silicon, 7–9 interleaved rounds, medians, audit off, release builds,
identical checksums before/after. Three shapes back to back: a `set_or_panic`
sweep (replace_T per slot, donor `mv` spelling), an `at_or_panic` read sweep
(load_T per slot, inline-spliced), and a `pop` sweep (move_T per slot).

| Backend |   n = 2M (median) | n = 5M (median) |        Δ |
| ------- | ----------------: | --------------: | -------: |
| aarch64 | 0.0618s → 0.0544s | 0.153s → 0.134s | **−12%** |
| C       | 0.0094s → 0.0094s | 0.023s → 0.023s |    ~flat |

Per slot the elided work is exactly the item's promise: the `bl _memcpy`
call and its register parking become one load-pair + store-pair (move/shift
also drop the `bl _memset`; the pair zero is one `stp xzr, xzr`). The
emitted splice receipts it: the 16-byte `replace` is
`lsl x1, x1, #4 / add x0, x0, x1 / ldp x9, x10, [x2] / stp x9, x10, [x0]`.

- _The standard suite_ — flat on both backends (medians, interleaved, outputs
  byte-identical): json-serde aarch64 0.694 → 0.695s, C 0.397 → 0.397s;
  binarytrees 1.86 → 1.84s aarch64, 1.43 → 1.43s C; nsieve 0.16/0.13s
  unchanged; lru aarch64 1.787 → 1.715s (−4% median / −1.6% min against a
  ±0.7% same-binary race spread — its only textual delta is the added dead
  pair labels shifting code addresses, so this is layout displacement, the
  documented aarch64 text-sensitivity, not a causal win), lru C flat. Two
  tests in `test/buffer_word_pairs.test.ts` pin the runtime round-trip
  (set/at/pop/copy on both backends, audit on) and the emitted pair splices
  (pair arms present, no memcpy on the taken replace path); the full suite
  (531 files, both backends) passes.

- _json-serde stays flat — the booking was wrong about the mechanism._ The
  plan (and bench/IMPROVEMENTS.md) booked this item against json-serde, but
  its slot types are `JsonNode` (56 bytes — the owning specialization's
  memcpy stays, correctly) and `int`/`uint64` scalars (the ≤ 8 width match
  already covered them). No 16-byte element exists in the program, and the
  .s diff confirms every hot path is identical. The item's win is real for
  genuine 16-byte elements (the shape above); it just wasn't json-serde's.

**Remainder.** `StableList.push_tail` still pays memcpy + memset per tail
push at every T_SIZE — the same pair treatment would apply when a
chunked-storage shape shows up in a hot loop. Structs of 24/32 bytes could
take two/three `ldp`/`stp` pairs instead of the memcpy call; left unmeasured
(the item's contract was ≤ 16).

## 15. aarch64 codegen receipts — the 64-bit arithmetic folds LANDED (Nov 2026)

Not both-backend, but measured and queued in ASM_TODO/FOLLOWUP:

- ~~**Three 64-bit arithmetic folds** (constant materialization, field-value
  forwarding, immediate shifts — FOLLOWUP.md): `Random.next` is ~40
  instructions vs ~14 raw. Generalizes to all pure-Nomen 64-bit math.~~
  **LANDED Nov 2026 (below).**
- **Splice cost model for auto-inline** — "small tranche, clear receipt": the
  call-bearing auto-inline is a measured +1.2% pidigits regression from
  hot-loop text displacement.
- **NEON variable-shift reads** — checker half landed; planner support is the
  remainder (ASM_TODO).
- **Per-receiver `bl` cache invalidation** — receipt-gated and paused; step 0
  is investigating a suspected stale-pointer bug first. Don't touch before
  that.

### The three 64-bit arithmetic folds — LANDED (Nov 2026)

**What landed.** A late ASM pass, `src/build_aarch64/asm_fold64.ts`
(`fold_64bit_arithmetic`, kill-switchable via `set_fold64_enabled`), running
in build.ts AFTER `expand_large_mov_immediates` (the chunk chains it folds
exist only after that pass) and BEFORE the lift/validators — whose ldr table
gained the `["r", "l"]` literal-load shape (`ldr xN, .LC64_N`). Three folds,
each semantics-preserving by construction:

- **Immediate shift counts.** `mov xR, #N` + `lsl/lsr/asr xD, xS, xR` (the
  emitter materializes every shift count as a value) folds to the immediate
  form `lsr xD, xS, #N` (−1 instruction per shift). Gates: straight-line
  adjacency (blank/comment lines may sit between; a label refuses), the count
  in the hardware's range (0–63 for an x-destination, 0–31 for w), the count
  register is not the shifted SOURCE (it feeds the data path there), and when
  the shift does not redefine the count register, a forward scan proves the
  register is redefined before anything reads it (the deleted mov's value must
  be unobservable). xR == xD — the common emitter shape — needs no scan: a
  shift reads its count operand at instruction start, so the destination's
  redefinition cannot shadow it.
- **Field-value forwarding.** `self.state = …; var z = self.state` emitted
  `str xV, [xS, #K] / mov xT, xS / ldr xD, [xT, #K]` — a store of a value the
  very next statement reloaded from the same slot. When nothing but blank
  lines separates the store from the reload (direct or through the receiver
  re-derivation), the slot holds exactly xV, so the reload forwards to
  `mov xD, xV` — deleted outright when xD == xV, the shape's common form.
  A `bl` in the window could mutate the field or clobber xV, so only the
  blank-window shapes fold; width-matched pairs only (x↔x, w↔w — the
  zero-extension discipline is identical).
- **Constant materialization.** Each 64-bit literal expanded to a
  `movz`/`movn` + up-to-three-`movk` chunk chain (4 instructions — what
  `expand_large_mov_immediates` replaced the raw `ldr xN, =K` with, after its
  assembler-sited pool fell out of the ±1 MB literal reach in multi-MB
  programs). A full-width chain (≥ 2 movk links) now rewrites to ONE
  pc-relative literal load, `ldr xN, .LC64_N`, whose `.quad` entry is emitted
  right after the function's final `ret` — adjacent, so the ±1 MB reach can
  never overflow (a 100k-line placement guard covers the pathological no-ret
  scan), and after a `ret`, so no fall-through ever executes the data bytes.
  Values dedupe per pool; ≥ 2^63 patterns emit as signed decimal (an unsigned
  `.quad` literal overflows the assembler's range check).

Twenty-two tests in `test/asm_fold64.test.ts` pin each fold's firing and
refusal shapes at the unit level (validated against `validate_asm` — the
literal ldr form is a contracted shape), the kill switch's byte-identical off
arm, the splitmix emitted-code pin (immediate shifts, pooled constants, no
reload after the store, the pool after the epilogue's ret, ≤ 28 body
instructions), and the runtime sequence; the full suite (547 files, both
backends) passes.

**Measured.** Shape micro-bench — `bench/nomen/splitmix_folds.nm` (the
`Random.next` body copied into the TU, stepped n times from a fixed seed,
checksum printed). A/B binaries from the same compiler with the pass toggled
(the off arm is byte-identical to HEAD's emission); n = 50M steps, Apple
Silicon, 7 interleaved rounds, medians, audit off, identical outputs:

| Arm                | R_next body instructions | median          |
| ------------------ | -----------------------: | --------------- |
| folds off (= HEAD) |                       39 | 0.070s          |
| folds on           |                25 (−36%) | 0.062s (−10.5%) |

Per step the elided work is exactly the trio's promise: three 4-instruction
constant chains become one `ldr` each (−9), the store-then-reload of
`self.state` disappears (−2), the three register shift counts become
immediates (−3), 39 → 25. The remaining delta to the ~14-instruction raw body
is the call protocol's own prologue/epilogue (9) and the x12/x1 value
staging (3) — the coalescer's territory, not the folds'.

- _The standard suite_ — built A/B the same way (single-TU, audit off,
  identical outputs, 7 interleaved medians): json-serde
  `bench/sample.json 50000` flat (0.407 → 0.408s), binarytrees 18 1.841 →
  1.805s (**−1.9%**), lru `1000 20000000` 1.713 → 1.686s (**−1.6%**), nsieve
  12 0.162 → 0.155s (**−4.3%**). No regressions; the wins land wherever
  pure-Nomen 64-bit math sits in a hot loop (nsieve's bit sieve most of all).
  On the C backend the item is invisible by construction (clang -O2 already
  emitted the immediate-shift and pooled-constant forms; nothing changed).

**Remainder.** The other three receipts of this item are unchanged: the
splice cost model, NEON variable-shift planner support, and the
per-receiver `bl` cache (paused pending its bug investigation).

## 16. Async paths audit (unexplored)

Fiber/Task/Channel/Nursery spawn machinery does allocation and copying that no
bench exercises. If GUI/async apps matter as a target, an audit there is
both-backend territory nobody has measured.

## 17. Minor batch

- ~~`List.remove_at_or_panic` shifts one element per iteration (`Buffer.shift` =
  memcpy + memset per element); a single tail memmove + one memset would do.~~
  **LANDED Oct 2026: −91% / −61% on the removal shape (17a below).**
- StableList's non-in-place tail push relays through the `stage` slot
  (store → memcpy → memset); a bare-value tail push could relay directly
  chunk→slot.
  **LANDED Oct 2026: −14% aarch64 / flat C on the tail-push shape (17b below).**
- `Array<T>.set` for strings does `free(old); strdup(new)` per store; an
  in-place variant would let a producer write the slot directly.
  **LANDED Oct 2026: −51% / −48% on the producer-store shape (17c below).**
- `json_parse_string` appends per byte; a scan-to-next-escape + bulk append
  would help parse-heavy workloads.
  **LANDED Oct 2026: −44% / −33% on the long-string doc, −12% / −9% json-serde
  (17d below).**

### 17a. `List.remove_at_or_panic` bulk tail move — LANDED (Oct 2026)

**What landed.** The backward shift after a removal is ONE block transfer
instead of a per-element `shift` loop. `Buffer` gained an INTERNAL
`move_range(dst, src, count)` raw primitive (`core/System/Buffer.nm`, the
ClassBuffer twin for class/trait elements alongside): a single `memmove` over
the `count`-slot tail — the bytes carry mv elements' heap pointers wholesale,
exactly the per-element `shift` semantics — plus one `memset` of the source
slots the destination never covers ([dst + count, src + count), which is ONE
slot for the contiguous deletion shape src = dst + 1). `List.remove_at_or_panic`
(`core/System/List.nm`) calls it once after `move(i)` instead of looping
`shift(j, j + 1)`.

The soundness contract is the caller-side proof obligation (documented on the
primitive, like `slot_ptr`'s): every slot in [dst, dst + count) must be DEAD —
zeroed by a move-out or otherwise unowned — because the block move overwrites
them without reclaiming. In `remove_at_or_panic` the moved-out slot i is zeroed
by `move`, and the memmove itself relocates every later value to the slot one
before it (overwritten bytes are still owned, just at the earlier slot), so
exactly-once ownership holds for every element kind; the uncovered tail slot
zeroes. A live displaced value belongs in `shift`, which reclaims dst first —
Map/Set.remove keep it. The raw bodies never name T (byte math), so one body
serves every element kind; `bl _memmove` resolves at link time like
`_memcpy`/`_memset`.

Three tests in `test/list_remove_at.test.ts`: the runtime round-trip
(middle/front/last removals across strings, mv structs with string fields, and
ints — both backends, audit on, so every removed element must be released
exactly once), the aarch64 emitted-code pin (the splice's count guard +
`bl _memmove` + `bl _memset`, no per-element shift loop), and the C pin (the
bulk `move_range` helper call). The full suite (534 files, both backends)
passes; the ClassBuffer twin is pinned by the trait-list runtime tests that
motivated it.

**Measured.** Shape micro-bench — `bench/nomen/list_remove.nm`: a
`List<string>` drained front-first (the worst shape: removal k shifts n−k
elements) and refilled from empty, n = 8000 × 5 rounds (each round ≈ 32M
element-shifts), n/rounds from argv, Apple Silicon, release builds, audit off,
checksums identical before/after; "before" binaries built from a HEAD worktree;
7 interleaved rounds, medians:

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| aarch64 |          0.270s |         0.023s | **−91%** |
| C       |          0.049s |         0.019s | **−61%** |

Per removal the elided work is exactly the item's promise: count memcpy +
memset call pairs per removal (the string specialization adds a displaced
free per element) become one `_memmove` + one `_memset` — ~8000 `bl` pairs
per removal become 2 `bl`s. The C backend collects less because -O2 had
already inlined the per-element shift into a tight vectorizable loop (the
item-4/7 footnote again); aarch64 issues the calls and collects the full
elision.

- _The standard suite_ — flat on C (medians, interleaved, outputs
  byte-identical): json-serde 0.04 → 0.04s, binarytrees 1.40 → 1.41s, lru
  `1000 20000000` 0.88 → 0.88s, nsieve 0.13 → 0.13s. No bench hot loop
  removes from a List; the win lives in the removal shapes above.

**Remainder.** Map/Set.remove's backward shift keeps per-element `shift`
(their dst slots are also dead-after-move, so the same `move_range` applies —
but their probe loop interleaves key compares, so the shape is less purely
block-shaped). Since measured: attempted and rejected — 17r below; the
tombstone alternative too — 18 below.

### 17r. Map/Set.remove bulk `move_range` — REJECTED (Nov 2026)

**What was tried.** The 17a contract applied to Map/Set.remove's backward
shift. The observation is sound: entries that move do so in contiguous
chains — after a move gap becomes k, so the next moveable entry at k + 1
shifts into k, each entry landing exactly one slot below where it was — so a
chain can flush as ONE `Buffer.move_range`/`ClassBuffer.move_range` block,
with the hash words relocated in their own u32 loop (move_range's T_SIZE
stride does not fit the `alloc_u32` slabs) and the `used` words needing no
per-move updates at all (every slot in the scan stays used=1; the final
store opens the end hole). Four shapes of the idea were built and measured:
a `flush_run` helper method on the struct; the flush inlined at the
chain-break sites; an up-front `move(idx)` of the removed entry vs a lazy
one at the first overwrite; and shift-first-then-batch — the original
per-entry shift runs unconditionally and the chain's remainder block-moves
after it, which satisfies move_range's dead-dst contract through the shift
itself (the shift zeroes the slot it just vacated) and needs no move-out
anywhere. All of them kept a ≥ 4-entry run threshold below which the
per-element shifts stay, and all of them passed the full test suite with a
new runtime + emission test file.

**Why it failed.** The shape win is real. Draining a long displaced chain
head-first — `bench/nomen/map_remove.nm`: all n keys collide on one home
slot, Map<int, Rec> with 48-byte mv-struct values (two owning strings),
n = 12000 × 3 rounds, n/rounds from argv, Apple Silicon, 7 randomized
interleaved rounds, medians, release builds, audit off, checksums identical;
"before" binaries from a HEAD worktree:

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| aarch64 |          0.133s |         0.064s | **−52%** |
| C       |          0.054s |         0.047s | **−11%** |

But lru — the one standard-suite bench that lives inside Map.remove, its
evict path calling `keys.remove` ~10M times per run — pays for the
count-before-shift on exactly the opposite shape: random keys at 49% load
make chains short (1–3 entries) and successors are often at their homes, so
the batch rarely fires while every remove carries the probe tax (the
contiguity check, the count loop probing the slot the outer loop re-probes
anyway, and the extra data-dependent branch mispredicts).
**lru +4–6% aarch64 / +2–4% C** on every variant (randomized-order A/B,
25 rounds; medians and mins agree). Three checks pin the cause: an lru build
with the `keys.remove` call deleted is byte-flat before/after, so the whole
regression lives in remove; the at-home scan shape (a 10k-entry cluster of
at-home keys — scan-heavy, shift-free) is flat; and binarytrees, which uses
no Map, generates byte-identical code and swings only ±1% (the noise floor).
Five designs, same tax: counting before shifting costs probes, and a probe
costs as much as the shift it might replace — the caller cannot know the
chain is long without counting it. Every landed item held the standard
suite flat; this one cannot, so it is rejected instead of shipped with a
regression.

**What stays true.** The ownership analysis from the attempt, for whoever
revisits deletion with tombstones or a different scheme: move_range's
dead-dst contract is satisfiable inside remove with no up-front move-out
(shift reclaims its own dst, so a batch whose first destination slot was
just shifted is sound), the hash words are the only side data that needs
relocating, and the no-shift removal leaves the removed entry owned by its
slot for the container's destroy (the pre-existing behavior). And the
profiling by-product: the SCAN (find the cluster end) is ~60% of lru — a
bigger target than the shifts ever were (FOLLOWUP.md).

### 17b. StableList tail push: direct chunk store — LANDED (Oct 2026)

**What landed.** A non-in-place `StableList<T>` push with `length >= 256`
(directory chunks) used to relay through a one-slot `stage` Buffer: the typed
`store` landed the value in the stage slot (deep-copy semantics), then a raw
`push_tail` byte-moved stage → chunk (`memcpy`) and zeroed the stage
(`memset`) — three operations, two `bl`s, and the relay call per push. The
tail push now stores DIRECTLY into the chunk slot:

- `Buffer.store_in_slab(slab, fill, slot, val)` (+ the `ClassBuffer` twin for
  class/trait element lists) — INTERNAL, typed Nomen: `init_view` points the
  buffer at the foreign slab, the mono'd `store` runs its per-element
  specialization (deep copy for owning elements, pointer store for classes),
  `clear_view` resets `data`/`cap` so the holder's teardown reclaims nothing.
  `Buffer.init_view`/`clear_view` are the two pieces; the view owns nothing —
  the slab keeps its real owner (StableList).
- `StableList.push`'s tail branch calls it with the `stage` FIELD as the
  transient carrier (`self.stage.store_in_slab(...)`). The field is essential:
  an owning `Buffer` LOCAL is auto-destroyed at scope exit (the shared
  auto-free rule for destroy-bearing struct locals) and would free the slab it
  only borrows — the field's own destroy sees `data = 0`, so it is a no-op.
- `push_tail` is deleted; `ensure_chunk` (the calloc-if-zero) moved into
  push's tail branch (the in-place `reserve` path already called it). The
  stage field is no longer allocated — it is a pure view carrier.

Three tests in `test/stable_list_tail_push.test.ts`: the runtime round-trip
(strings, mv structs with string fields, producer pushes, and ints all across
the chunk boundary — both backends, audit on, so every element is released
exactly once), and the emitted-code pins (aarch64 push calls
`ensure_chunk` + `Buffer_string_store_in_slab` and no `push_tail`/relay
`_memcpy` remains; C push calls the view store). The full suite (536 files,
both backends) passes.

**Measured.** Shape micro-bench — `bench/nomen/stable_push.nm`: n
donor-spelled pushes of a static seed string into a `StableList<string>`
(every push after the first 256 takes the tail path; ~78k directory chunks at
20M) plus an n-read `.length` sweep, n from argv, Apple Silicon, release
builds, audit off, checksums identical before/after; "before" binaries built
from a HEAD worktree (the item-1 commit); 5 interleaved rounds, medians:

| Backend | n   | before (median) | after (median) |        Δ |
| ------- | --- | --------------: | -------------: | -------: |
| aarch64 | 5M  |          0.440s |         0.385s | **−13%** |
| aarch64 | 20M |          1.770s |         1.520s | **−14%** |
| C       | 5M  |          0.520s |         0.520s |    ~flat |
| C       | 20M |          2.140s |         2.130s |    ~flat |

Per tail push the elided work is the relay: the stage slot hop (a second
16-byte slot write), the `memcpy` + `memset` `bl` pair, and push_tail's call
plumbing (prologue/epilogue + the calloc check, now inlined in push). The
deep-copy store itself — the per-slot strdup both lowerings pay — stays; the
donor spelling is the shape, not an allocation win. The C backend is flat
because -O2 had already inlined push_tail's 16-byte memcpy/memset into a pair
of moves (the item-4/7/17a footnote again); aarch64 issues the calls and
collects the elision.

- _The standard suite_ — flat on C (medians, interleaved, outputs
  byte-identical): json-serde 0.04 → 0.04s, binarytrees 1.39 → 1.39s, lru
  `1000 20000000` 0.86 → 0.83s (layout noise; lru does not use StableList),
  nsieve 0.12 → 0.12s.

**Remainder.** The in-place push path (producer arguments) never used the
stage and is untouched. `StableList.copy` still pushes element-by-element
through `at` + `push` (load_T + store per element); a bulk `Buffer` view copy
would apply but is a different shape.

### 17c. `Array<T>.set` in-place producer store — LANDED (Oct 2026)

**What landed.** The in-place STORE contract (item 6) extended to heap
`Array<T>` receivers: `arr.set(i, f(x))` where f's result type is the element
type now constructs f's result straight into element i — no `_param_N` temp
home, no callee `free(old); strdup(new)`, no temp free at scope exit (2
mallocs + 1 free per store become 1 malloc, plus the displaced-value free both
lowerings owe).

- **Checker** (`src/check/check_function_call.ts`): an `Array<T>` receiver
  parses to the ELEMENT type with `is_array` (there is no container struct
  instance to look a slot primitive up on), so the store gate gained an array
  branch: `slot_ptr` is the builtin element-slot contract. Array.set's value
  parameter is a BORROW (`T value`, not `mv`), and the stamped lowering never
  runs the callee — the producer's result IS the slot's new value and the
  displaced value is reclaimed first — so the `mv` requirement is relaxed for
  array receivers only. The `in_place_store_receiver_ok` rules (bare local,
  statement position) are unchanged.
- **aarch64** (`src/build_aarch64/build_in_place_push.ts`): the splice
  computes the element base with the Array receiver convention
  (`[[local]] + 8` for a heap array block — the length word precedes the
  elements; the local's own address for inline storage) and the slot address
  inline (`madd base, index, stride`), then reclaims and constructs as the
  List/Buffer splice already did. No core slot primitive is needed.
- **C** (`src/build_c/build_access_node.ts`): the splice emits the address as
  an expression — `((T*)((char*)arr + sizeof(struct Array_<T>))) + i` for a
  heap array local, `((T*)arr) + i` for inline storage — followed by the same
  displaced reclaim and the producer-call assignment.
- `in_place_push_facts` carries a `receiver_is_array` fact (and derives the
  `Array_<elem>` mono name, since the parsed type's name is the element).

Three tests in `test/array_in_place_set.test.ts` (runtime: six producer stores
into an `Array.with`-built string array, then a borrowed-local control store —
both backends, audit on; emitted-code pins: the aarch64 inline `madd` slot +
reclaim + pair store with no `Array_string_slot_ptr`, the C slot expression
and producer assignment). The full suite (536 files, both backends) passes.

**Measured.** Shape micro-bench — `bench/nomen/array_set.nm`: 100 000-element
`Array<string>` (built with `Array.with`), `arr.set(i, make(i))` over the whole
array per round (the producer interpolates `"val\{i}"` — one malloc the store
cannot elide), then a read sweep; rounds from argv (100 rounds = 10M stores),
Apple Silicon, release builds, audit off, checksums identical before/after;
"before" binaries built from a HEAD worktree (the item-2 commit); 5
interleaved rounds, medians:

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| C       |          0.880s |         0.430s | **−51%** |
| aarch64 |          0.840s |         0.440s | **−48%** |

Per store the elided work is exactly the item's promise: the hoisted
`_param_N` temp's slot, the set callee's `strdup` of it, and the temp's
scope-exit free — one malloc + one free per store, on top of the displaced
free both sides pay. Both backends collect it (the C backend because the
stamp removes the temp and the callee copy at the source level, not via the
optimizer).

- _The standard suite_ — flat with outputs byte-identical: fannkuch-redux
  (the array-`set`-heavy bench, int elements — never stamped) 0.10 → 0.10s,
  json-serde flat, binarytrees 1.40 → 1.39s, lru flat, nsieve 0.12 → 0.12s.

**Remainder.** The item's original remainder was a pre-existing bug, since
fixed: an `Array<string>` built from a LITERAL (`var arr = ["a", "b"]`)
stored rodata pointers in its slots, so any `set` (in-place or not) freed
static memory (`Array.with` — which strdups its seed per slot — was the
supported constructor). Fixed 2026-10-31 (d01b412f "Array<string> literal
rows own heap copies"): the literal build strdups each string row, so every
slot owns its heap bytes like `Array.with`'s, the displaced free is valid,
and `set` spells a dedicated owned-slot store (a fresh-heap producer
transfers as-is, anything else strdups) — pinned by `test/arrays.test.ts`
on both backends. The `for ref x of strings` item-reassignment leak that
fix surfaced landed separately (acc85356). Inline (stack) storage arrays
take the splice's non-heap address branch, but a string stack array without
initialisation has uninitialized slots (the reclaim would free garbage) —
no such shape is constructible through the checked language today.

### 17d. `json_parse_string`/`json_parse_number` scan + bulk append — LANDED (Oct 2026)

**What landed.** The JSON scanners no longer append one byte per iteration
(each `append_char` pays the builder's capacity check, bounds math, and length
bump):

- **`json_parse_string`** (`core/System/Text/Json.nm`): the loop scans to the
  next `"` or `\` and appends the whole plain run as ONE
  `append_string_view(s.slice(run_start, i))` — a single `memcpy` — then
  decodes the escape byte (whose single-byte appends remain; they are one
  byte by definition). Escape semantics are unchanged, including the
  unknown-escape fallback (`\q` → `q`). One malformed-border case improves:
  a trailing backslash at end-of-input now leaves the position AT the limit
  (`len`) instead of one past it — the rewrite's `while i < len` guard, where
  the old loop's unconditional increment could store `len + 1`.
- **`json_parse_number`**: the scan already found the number's end; only its
  copy loop remained — `while j < i { append_char }` became one
  `append_string_view(s.slice(start, i))`.

Three tests in `test/json_parse_bulk.test.ts` (runtime: a 50-byte plain run,
every escape case with character-code assertions, and a number run — both
backends, audit on; emitted-code pins: the C and aarch64 scanner bodies call
`append_string_view` and hold no per-byte run appends — the escape decode's
are bounded at 2). The full suite (537 files, both backends) passes.

**Measured.** The standard `bench/nomen/json-serde.nm` (parse + re-stringify
cycles, `bench/sample.json`, n = 50 000) plus a string-heavy document (2000
keys × 200-character values, n = 3000 — the shape the per-byte append hurts
most), Apple Silicon, release builds, audit off, identical outputs
before/after; "before" binaries built from a HEAD worktree (the item-3
commit); 5 interleaved rounds, medians:

| Shape                       | Backend | before (median) | after (median) |        Δ |
| --------------------------- | ------- | --------------: | -------------: | -------: |
| sample.json, n = 50 000     | C       |          0.400s |         0.350s | **−13%** |
| sample.json, n = 50 000     | aarch64 |          0.690s |         0.620s |  **−9%** |
| 2000×200-char doc, n = 3000 | C       |          2.970s |         1.990s | **−33%** |
| 2000×200-char doc, n = 3000 | aarch64 |          5.570s |         3.130s | **−44%** |

Per string byte the elided work is exactly the item's promise: the
per-byte builder append (capacity check + store + length bump, plus its
bounds math) becomes one memcpy per run — the win scales with run length,
which is why the long-string document collects 3–5× the sample.json delta.
sample.json's strings are short, so the fixed per-string overhead dominates
there.

- _The standard suite_ — flat, outputs identical: binarytrees 1.41 → 1.41s,
  lru flat, nsieve 0.12 → 0.13s, fannkuch-redux 0.10 → 0.10s.

**Remainder.** The serializer's per-string path was already bulk (item 5).
`json_parse_literal` parses at most 4 bytes (no run to bulk up).
`String.replace_first` keeps its per-byte appends by design (item 8's
remainder).

## 18. Tombstone deletion for Map/Set — REJECTED (Nov 2026)

The other deletion scheme for open addressing: `remove` frees the entry and
marks the slot dead (O(1), no backward-shift scan) — lookups skip dead
slots, inserts reuse the first dead slot their probe passes, and the insert-
time load factor counts dead slots so a dirty table rebuilds itself. The
mainstream choice: CPython's dict (dummies), Go's runtime map (`emptyOne`/
`emptyRest` tophash), Rust's hashbrown and absl's Swiss tables (`DELETED`
control bytes), Zig's HashMap, Lua (dead keys). Built completely — a third
`used` state (the existing u32 word, zero extra memory), a `tombstones`
counter on both structs, reuse-on-insert probes (`insert_slot` beside
`find_slot`), tombstone-aware `rehash`/`copy`, live-count-driven growth
plus dead-count-driven same-capacity compaction (Go/CPython's policy split —
an earlier single-trigger policy ratcheted the capacity of churn tables
upward, and a stale-`cap` ordering bug between the two triggers oscillated
tables full; both found by the tests and fixed) — full suite green with a
new runtime + emission test file.

**Measured.** The chain-drain shape (17r's `bench/nomen/map_remove.nm`,
Map<int, Rec>, 48-byte mv-struct values, n = 12000 × 3, randomized
interleaved A/B, medians, release, checksums identical):

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| aarch64 |          0.136s |         0.063s | **−54%** |
| C       |          0.056s |         0.050s |  **−9%** |

And the workload every Map deletion change must answer to — lru (`1000
20000000`; ~10M `keys.remove` evictions + ~10M inserts + 40M `get_or`
lookups per run):

| Backend | before (median) | after (median) |        Δ |
| ------- | --------------: | -------------: | -------: |
| aarch64 |          1.683s |         2.305s | **+37%** |
| C       |          0.884s |         1.220s | **+38%** |

**Why it loses.** Under churn, tombstones accumulate until the EFFECTIVE
occupancy — (live + dead)/cap — equilibrates far above the nominal 3/4 load
factor (reuse-on-insert consumes dead slots only when an insert's probe
happens to pass one, so the compaction trigger rarely fires), and every one
of lru's 40M lookups then probes through near-full tables of dead 16–48-
byte owning slots. The mainstream implementations absorb dead-slot density
with structure Nomen's flat scalar probing lacks: CPython's dummies live in
a separate compact index array (probe steps are 1-byte index loads), Go
terminates dead runs early (`emptyRest`) and groups 8 slots per bucket,
and hashbrown/absl scan 16 control bytes per step with SIMD — a tombstone
is one more lane in a vectorized compare. Nomen's probe touches a full
owning slot per step, so density multiplies directly into cache misses.
(The C backend regressed equally, so this is not an aarch64 codegen
artifact.) The original design comment — "No tombstones … the cost is the
local cluster length" — is exactly right for scalar probing at these load
factors: backward-shift keeps the table maximally clean and lru's clusters
short (its removal cost is the SCAN, 17r's finding), while tombstoning
trades that scan for permanently dirtier tables. Rejected; 17r's shape win
stays on the table only for a scheme that also fixes the scan (a different
data layout, not a different deletion policy). Within the CURRENT layout
the one unexplored scan lever is backward-shift START-POSITION MEMOIZATION
(remember, per removed slot, where the next cluster-end scan can resume —
speculative, unmeasured); shrinking the per-step probe cost is remainders
item 6.

## Already rejected — don't re-suggest

Adjacent `str`/`ldr` elimination and write-only-slot elimination (unsound at
text level), `Buffer.data` pointer LICM (reverted, no win), dead-move
elimination (measured regression, ships off), x15 reservation, d0–d7 float
params, `append_string` naked-inline (−8% regex-redux), and any bench-source
node pooling (excluded for fairness). Full receipts in PERF.md's Rejected
table and bench/IMPROVEMENTS.md.
