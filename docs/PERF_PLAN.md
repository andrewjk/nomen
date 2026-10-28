# PERF_PLAN.md — Performance Plan

Research into the next performance opportunities, following the StableList +
in-place push work. PERF.md is the record of what landed; this is the plan for
what's next. All findings are ordered most-promising-first. Written Oct 2026;
originally unmeasured — items 2 and 3 have since landed with measurements in
place (items marked LANDED carry them; the rest carry expected wins and the
receipts they rest on).

| #   | Item                                                                             | Backends       | Effort | Receipt                                               |
| --- | -------------------------------------------------------------------------------- | -------------- | ------ | ----------------------------------------------------- |
| 1   | Faster allocator (slab/bump class allocation)                                    | both           | M      | PERF.md "Large"; ASM_TODO "largest unclaimed"         |
| 2   | ~~In-place push for constructors~~ **LANDED Oct 2026: −55% / −58% on the shape** | both           | S      | shape micro-bench, interleaved medians (below)        |
| 3   | ~~Move-on-last-use for structs~~ **LANDED Oct 2026: −20% / −29% on the shape**   | both           | S–M    | shape micro-bench, interleaved medians (below)        |
| 4   | Borrow-returning reads (Map `get_ptr`, `at_view`)                                | both           | M      | lru hot loop double-probes; per-read container copies |
| 5   | Json ownership copies                                                            | both           | S      | measured 0.7.0 regression +61% / +103%                |
| 6   | In-place store (`set`/`insert`/`add`/`alloc`)                                    | both           | M      | slot primitives already exist                         |
| 7   | Enum payload in-place construction                                               | both           | S–M    | mechanically same as in-place push                    |
| 8   | Regex/String O(n²) accumulators                                                  | both           | S      | O(n²) per-byte loops in core                          |
| 9   | Map/Set stored hash (Swiss-table tricks)                                         | both           | M      | rehash re-hashes every key                            |
| 10  | StringBuilder numeric appends + 1-pass interp                                    | both           | S      | two snprintf passes + malloc per append               |
| 11  | Devirtualization of trait calls                                                  | both           | M      | unmeasured                                            |
| 12  | Struct field-order / padding                                                     | both           | S      | modest; raw-body caveat                               |
| 13  | Variable-mode enums                                                              | both           | L      | GOOSE #6, documented, unshipped                       |
| 14  | Buffer word pairs (T_SIZE ≤ 16)                                                  | mostly aarch64 | S      | IMPROVEMENTS.md "still needed"                        |
| 15  | aarch64 codegen receipts (splice model, folds…)                                  | aarch64        | S–M    | measured regressions to reclaim                       |
| 16  | Async paths audit                                                                | both           | ?      | unexplored, unmeasured                                |
| 17  | Minor batch                                                                      | both           | S      | assorted                                              |

## 1. Faster allocator — slab/bump the class-allocation path

PERF.md's only "Large" row; ASM_TODO calls it "the largest unclaimed perf
lever". Every class instance mallocs in the magic ctor
(`src/build_aarch64/build_magic_ctor.ts`, same shape in the C backend);
binarytrees/merkletrees are allocation-dominated and the tree benches
regressed further with the class→mv-struct+Box idiom ("alloc + struct memcpy
per child now", FOLLOWUP.md). Slab/bump the per-instance path. Fairness-honest:
the excluded dodge is source-level pooling, and the Go/Rust/Zig references all
have fast allocators.

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

**Remainder.** `JsonTree.alloc_node` still misses the guarantee — not because
of the ctor shape (fixed here) but because its receiver is a field path
(`self.nodes`), which the tranche's bare-local rule excludes (the aarch64
`emit_var_address` has no field-path form, and the slot address must be
re-derived after the constructing call). Extending the receiver side to
`self.<field>` paths is the natural sibling item; it needs a field-path
addressing primitive first.

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

**Remainder.** Only whole-RHS sites (assignment + declare) rewrite today.
The same elision applies at the other ownership-transfer positions —
`return src.copy()`, call arguments, container stores
(`list.push(src.copy())`), field stores — each needs its site's transfer
lowering checked against the rewrite (the return/arg paths move the donor
differently than the local-reassignment paths). Container-typed donors
(`var dst = list.copy()` where `list` is a `List`/`Map`/`Set` local) are
the natural sibling: the synthesized/library copy has the same
fresh-value shape, and the container `mv` transfer exists.

## 4. Borrow-returning reads

Two halves, one family:

- **Deep-copy-on-read for container-bearing structs.** The owning-specialized
  `load_T` deep-copies every `List`/`Buffer`/`Map`/`Set` field on _every read_
  — `.at(i)`, `.get(k)`, and each `for of` element
  (`src/build_c/utils/owning_buffer_specialize.ts`,
  `emit_load_deep_copy_fields`). `for node of outer_list` where `Outer` has a
  `List<string>` field clones the whole container per iteration, on both
  backends. Plain strings and scalars are already borrows on load — only
  container-field structs (and string-payload enums) pay.
- **Map `get_ptr` / has+get fusion.** `Map.has` + `Map.get` each run a full
  probe — the LRU bench's hottest loop does exactly this pair
  (`bench/nomen/lru.nm`). A `get_ptr(key) -> ptr TV` slot borrow (like
  `List.slot_ptr`) fuses probe + read, and is the anchor for in-place
  `set(key, f(x))` (item 6).

A `view`-returning accessor family (`at_view`/`get_view`) kills the copies;
the `view` machinery and the borrow-accessor classification already exist.

## 5. Json ownership copies

`set_text` does `n.text = text.copy()` on a string the caller just built
(`tree.set_text(n, sb.to_string())` = builder malloc → copy malloc → temp
free), and `get_text` returns `n.text.copy()` which callers immediately memcpy
into a StringBuilder and drop (`core/System/Text/JsonTree.nm`, callers in
`Json.nm`). A `mv` param + a `get_text_view` → zero mallocs. Every parsed
string/key pays this twice today — and the 0.7.0 json-serde regression
(FOLLOWUP.md) is attributed to exactly this class of ownership lowering.

## 6. In-place store: the `set`/`insert`/`add`/`alloc` siblings

`List.set(i, f(x))`, `Map.set(k, v)`, `Arena.alloc(f(x))`, `Buffer.set` all
still route through the `_param_N` hoist + deep copy. The slot-address
primitive (`slot_ptr(i)`) already exists on List/Buffer, and the donor spelling
(`var p = f(x); lst.set(i, mv p)`) already converges for push. Map needs
probe-then-construct — the key precedes the value in evaluation order, so
`set(key, f(x))` can probe first, then construct into `values.slot_ptr(idx)`
(needs item 4's slot API). Gate on string/value-struct elements as push does;
scalar elements have nothing to elide.

## 7. Enum payload in-place construction

`Result.ok(parse(line))` hoists the payload then strdups/struct-copies it into
the payload slot (`src/build_aarch64/build_access_node.ts`, hoist in
`enum_mono.ts`). The payload address is a known frame offset — mechanically
identical to in-place push's destination (preset x8 to `[x29, #off]` via the
existing `call_x8_preset` window). The fixed enum layout and its safety
argument (MEMORY.md) are untouched — this is only about where the payload is
constructed.

## 8. Regex/String O(n²) accumulators

`Regex.nm` builds matches with `match_result = match_result + "\{input.at(j)}"`
— per matched byte, one interpolation malloc _plus_ one whole-accumulator
re-copy. O(n²). Same per-byte pattern in `Regex.replace_all` and
`String.replace_all` — one `append_string_view(input.slice(...))` per run
replaces the byte loop. Also in the emitted code: the C backend's fixed-array
`to_string` does `realloc` + `strcat` per element (strcat rescans the
accumulator, `src/build_c/build_access_node.ts`).

## 9. Map/Set stored hash

`rehash` re-inserts via `self.set(mv k, mv v)` (`Map.nm`) — a full re-hash of
every key plus re-probe. The Swiss-table trick — store a per-slot hash word
(a fourth `Buffer<int>`), compare hashes before `memcmp` in probes, rehash
hash-free — is one buffer away. Composes with item 4 (hash check short-circuits
before the key compare).

## 10. StringBuilder numeric appends + single-pass interpolation

Every `sb.append(x.to_string())` costs two snprintf passes + malloc + free
(`int.nm`). An `append_int`/`append_float` raw primitive is a few instructions
against a fixed buffer. Same family: `"\{x} …"` interpolation lowers to one
`_string_interpolate_N` call = two snprintf passes (size, then write) + malloc;
a writer form appending into a StringBuilder (or stack chunks, one pass) helps
I/O-heavy code on both backends.

## 11. Devirtualization of trait calls

Trait dispatch always goes through the conformer's vtable
(`src/check/utils/trait_slot.ts`). When the concrete type is statically
visible — a local constructed from a known class, boxed and immediately called
— a direct call (opening an inline opportunity, where the aarch64 backend
shines) is possible. Pure checker/codegen change, both backends, unmeasured.

## 12. Struct field-order / padding

Layout is declaration order, so hot structs can carry padding (JsonNode-style
payloads are 48 bytes). Auto-reordering for packing shrinks and speeds both
backends — with one hard caveat: raw `#arch` bodies hardcode field offsets
(StableList hardcodes `length @8`, `items.data @24`, …), so it must skip
raw-body structs or be opt-in.

## 13. Variable-mode enums

GOOSE #6 — documented, never shipped. Tag + max-payload-room means every
`Option`/`Result`/AST node pays the largest variant; variable mode packs each
value to its variant's size (9/17/1 bytes instead of 17 each). The
freeze-at-construction constraint is exactly the safety argument MEMORY.md
already leans on. Token/AST-shaped workloads — the compiler's own — benefit on
both backends. Big change; long-term.

## 14. Buffer word pairs for T_SIZE ≤ 16

`load_T`/`store_T` for small structs as word-pair moves instead of `memcpy` —
already on the list (`bench/IMPROVEMENTS.md`, "still needed"), lifts json-serde
and the per-child memcpy in the tree benches. Mostly an aarch64 win (clang -O2
already inlines small memcpy on the C side).

## 15. aarch64 codegen receipts (from the project's own docs)

Not both-backend, but measured and queued in ASM_TODO/FOLLOWUP:

- **Splice cost model for auto-inline** — "small tranche, clear receipt": the
  call-bearing auto-inline is a measured +1.2% pidigits regression from
  hot-loop text displacement.
- **Three 64-bit arithmetic folds** (constant materialization, field-value
  forwarding, immediate shifts — FOLLOWUP.md): `Random.next` is ~40
  instructions vs ~14 raw. Generalizes to all pure-Nomen 64-bit math.
- **NEON variable-shift reads** — checker half landed; planner support is the
  remainder (ASM_TODO).
- **Per-receiver `bl` cache invalidation** — receipt-gated and paused; step 0
  is investigating a suspected stale-pointer bug first. Don't touch before
  that.

## 16. Async paths audit (unexplored)

Fiber/Task/Channel/Nursery spawn machinery does allocation and copying that no
bench exercises. If GUI/async apps matter as a target, an audit there is
both-backend territory nobody has measured.

## 17. Minor batch

- `List.remove_at_or_panic` shifts one element per iteration (`Buffer.shift` =
  memcpy + memset per element); a single tail memmove + one memset would do.
- StableList's non-in-place tail push relays through the `stage` slot
  (store → memcpy → memset); a bare-value tail push could relay directly
  chunk→slot.
- `Array<T>.set` for strings does `free(old); strdup(new)` per store; an
  in-place variant would let a producer write the slot directly.
- `json_parse_string` appends per byte; a scan-to-next-escape + bulk append
  would help parse-heavy workloads.

## Already rejected — don't re-suggest

Adjacent `str`/`ldr` elimination and write-only-slot elimination (unsound at
text level), `Buffer.data` pointer LICM (reverted, no win), dead-move
elimination (measured regression, ships off), x15 reservation, d0–d7 float
params, `append_string` naked-inline (−8% regex-redux), and any bench-source
node pooling (excluded for fairness). Full receipts in PERF.md's Rejected
table and bench/IMPROVEMENTS.md.
