# PERF_PLAN.md — Performance Plan

Research into the next performance opportunities, following the StableList +
in-place push work. PERF.md is the record of what landed; this is the plan for
what's next. All findings are ordered most-promising-first. Written Oct 2026;
originally unmeasured — items 2, 3, 4 (partially), 5, 6, 7, 8, 9, 10, and 11
have since landed with measurements in place (items marked LANDED carry them;
the rest carry expected wins and the receipts they rest on).

| #   | Item                                                                                                                                                                                                           | Backends       | Effort | Receipt                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ | ------------------------------------------------ |
| 1   | Faster allocator (slab/bump class allocation)                                                                                                                                                                  | both           | M      | PERF.md "Large"; ASM_TODO "largest unclaimed"    |
| 2   | ~~In-place push for constructors~~ **LANDED Oct 2026: −55% / −58% on the shape**                                                                                                                               | both           | S      | shape micro-bench, interleaved medians (below)   |
| 3   | ~~Move-on-last-use for structs~~ **LANDED Oct 2026: −20% / −29% on the shape**                                                                                                                                 | both           | S–M    | shape micro-bench, interleaved medians (below)   |
| 4   | ~~Borrow-returning reads (Map `get_ptr`, `at_view`)~~ **PARTIALLY LANDED Oct 2026: Map slot borrow, −79% / −98% on the borrow shape, −48% probe fusion**                                                       | both           | M      | shape micro-benches, interleaved medians (below) |
| 5   | ~~Json ownership copies~~ **LANDED Oct 2026: −26% / −13% on the ownership shape, −22% / −12% json-serde**                                                                                                      | both           | S      | measured 0.7.0 regression +61% / +103%           |
| 6   | ~~In-place store (`set`/`insert`/`add`/`alloc`)~~ **LANDED Oct 2026: −50% / −56% on the pure store shape, −64% Map replace**                                                                                   | both           | M      | shape micro-benches, interleaved medians (below) |
| 7   | ~~Enum payload in-place construction~~ **LANDED Oct 2026: −45% / −8% on the payload shapes (aarch64; C take-variant)**                                                                                         | both           | S–M    | shape micro-benches, interleaved medians (below) |
| 8   | ~~Regex/String O(n²) accumulators~~ **LANDED Oct 2026: −92% / −91% match accumulator, −65% / −58% replace_all skip loop, −33% / −40% String.replace_all, −28% / −14% array to_string**                         | both           | S      | shape micro-benches, interleaved medians (below) |
| 9   | ~~Map/Set stored hash (Swiss-table tricks)~~ **LANDED Oct 2026: −35% / −52% probe shape, −21% / −49% string build+remove, −19% / −33% Set build, −22% aarch64 int rehash; int-keyed hit paths +2–10% (below)** | both           | M      | shape micro-benches, interleaved medians (below) |
| 10  | ~~StringBuilder numeric appends + 1-pass interp~~ **LANDED Oct 2026: −80% / −79% interp, −76% / −75% numeric append, −66% / −70% new-spelling**                                                                | both           | S      | shape micro-benches, interleaved medians (below) |
| 11  | ~~Devirtualization of trait calls~~ **LANDED Oct 2026: −12% realistic callee / −31% trait-default (C), tiny-callee loop folds outright; aarch64 inline splice −19% (below)**                                   | both           | M      | shape micro-bench, interleaved medians (below)   |
| 12  | Struct field-order / padding                                                                                                                                                                                   | both           | S      | modest; raw-body caveat                          |
| 13  | Variable-mode enums                                                                                                                                                                                            | both           | L      | GOOSE #6, documented, unshipped                  |
| 14  | Buffer word pairs (T_SIZE ≤ 16)                                                                                                                                                                                | mostly aarch64 | S      | IMPROVEMENTS.md "still needed"                   |
| 15  | aarch64 codegen receipts (splice model, folds…)                                                                                                                                                                | aarch64        | S–M    | measured regressions to reclaim                  |
| 16  | Async paths audit                                                                                                                                                                                              | both           | ?      | unexplored, unmeasured                           |
| 17  | Minor batch                                                                                                                                                                                                    | both           | S      | assorted                                         |

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

## 4. Borrow-returning reads — PARTIALLY LANDED (Oct 2026)

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

**Remainder.** The `at_view`/`get_view` half of this item is NOT landed. A
`view`-returning accessor that kills the per-read copy for
container-bearing struct ELEMENTS (`for node of outer_list` where `Outer`
has a `List<string>` field) needs struct views: a `view Outer` value with
field access through it (the (ptr, len) view representation covers flat
data — strings and scalar arrays — but not struct fields, and the borrow
rules for nested container-field reads through a view are undesigned).
The `ref` element borrow covers the explicit-binding shape today; the
remaining victims are the expression-temp and `for of` positions (the
desugar lowers to `.at`, an owning read). Also recorded in FOLLOWUP.md:
scalar element borrows via `List.at` are blocked by contract verification
(the Map reads verify clean because `get_or_panic` carries no parameter
contract), so scalar borrows are Map-only until the verifier understands
the rewrite's length facts.

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

**Remainder.** Per node there is still the `JsonNode()` seed strdup inside
`alloc_node`'s push — item 2's field-path remainder (`self.nodes`
receiver) — and `json_parse_string`'s per-byte append loop (item 17's
scan-to-next-escape). A general `mv string` param that actually transfers
(eliding `set_text`'s copy for owned strings everywhere) is a convention
change across every mv-string function and needs its own measured item.

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
site would need the classifier, not the checker, to pick it). Struct
payloads with string fields hit a pre-existing ownership gap — the enum
teardown never frees a struct payload's heap fields (FOLLOWUP.md) — so the
in-place win there is booked on int-only payloads until that lands. The
donor spelling (`var p = make(i); var Res r = Res.ok(mv p)`) keeps the
ordinary mv transfer, as in every prior tranche.

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
