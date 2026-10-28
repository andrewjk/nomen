# PERF_PLAN.md — Performance Plan

Research into the next performance opportunities, following the StableList +
in-place push work. PERF.md is the record of what landed; this is the plan for
what's next. All findings are ordered most-promising-first. Written Oct 2026;
no new measurements yet — each item carries its expected win and the receipts
it rests on.

| #  | Item                                             | Backends      | Effort | Receipt                                        |
| -- | ------------------------------------------------ | ------------- | ------ | ---------------------------------------------- |
| 1  | Faster allocator (slab/bump class allocation)     | both          | M      | PERF.md "Large"; ASM_TODO "largest unclaimed"  |
| 2  | In-place push for constructors                    | both          | S      | sibling tranche measured −61% / −73%           |
| 3  | Move-on-last-use for structs (strings-only today) | both          | S–M    | tree-bench regression attributed to struct memcpy |
| 4  | Borrow-returning reads (Map `get_ptr`, `at_view`) | both          | M      | lru hot loop double-probes; per-read container copies |
| 5  | Json ownership copies                             | both          | S      | measured 0.7.0 regression +61% / +103%         |
| 6  | In-place store (`set`/`insert`/`add`/`alloc`)     | both          | M      | slot primitives already exist                  |
| 7  | Enum payload in-place construction                | both          | S–M    | mechanically same as in-place push             |
| 8  | Regex/String O(n²) accumulators                   | both          | S      | O(n²) per-byte loops in core                   |
| 9  | Map/Set stored hash (Swiss-table tricks)          | both          | M      | rehash re-hashes every key                     |
| 10 | StringBuilder numeric appends + 1-pass interp     | both          | S      | two snprintf passes + malloc per append        |
| 11 | Devirtualization of trait calls                   | both          | M      | unmeasured                                     |
| 12 | Struct field-order / padding                      | both          | S      | modest; raw-body caveat                        |
| 13 | Variable-mode enums                               | both          | L      | GOOSE #6, documented, unshipped                |
| 14 | Buffer word pairs (T_SIZE ≤ 16)                   | mostly aarch64 | S     | IMPROVEMENTS.md "still needed"                 |
| 15 | aarch64 codegen receipts (splice model, folds…)   | aarch64       | S–M    | measured regressions to reclaim                |
| 16 | Async paths audit                                 | both          | ?      | unexplored, unmeasured                         |
| 17 | Minor batch                                       | both          | S      | assorted                                       |

## 1. Faster allocator — slab/bump the class-allocation path

PERF.md's only "Large" row; ASM_TODO calls it "the largest unclaimed perf
lever". Every class instance mallocs in the magic ctor
(`src/build_aarch64/build_magic_ctor.ts`, same shape in the C backend);
binarytrees/merkletrees are allocation-dominated and the tree benches
regressed further with the class→mv-struct+Box idiom ("alloc + struct memcpy
per child now", FOLLOWUP.md). Slab/bump the per-instance path. Fairness-honest:
the excluded dodge is source-level pooling, and the Go/Rust/Zig references all
have fast allocators.

## 2. In-place push for constructors — the dominant excluded shape

The gate in `in_place_call_ok` (`src/check/check_function_call.ts`) rejects any
argument call whose name matches a struct ("no constructor/magic-ctor shape").
Counting push-argument shapes across `test/`, constructors dominate: 12×
`push(Res(7))`, 8× `push(Person(...))`, 4× `push(TextRule())` — nearly all
lower today as: ctor srets into a `_param_N` temp → push callee memcpys
temp→slot → temp teardown. `JsonTree.alloc_node` does
`self.nodes.push(JsonNode())` — the JSON pool itself misses the guarantee on
every parsed value. The precedent exists: `Box<T>(T(...))` already constructs
directly into the box slot (`box_ctor_in_place_arg`). Extending the stamp to
ctor arguments reuses the tranche-4 x8 re-preset threading as-is.

## 3. Move-on-last-use for structs

`src/check/utils/last_use.ts` is explicitly "mv-on-last-use **string**
assignment" (both backends gate on `rhs_is_string_var`). But `a = b` where `T`
is a mv struct with string/container fields deep-copies *every field*; if `b`
is genuinely dead after the assignment, a pointer steal needs zero copies. The
whole-function single-use counting machinery exists and works. This is exactly
the cost FOLLOWUP.md blames for the tree-bench regression.

## 4. Borrow-returning reads

Two halves, one family:

- **Deep-copy-on-read for container-bearing structs.** The owning-specialized
  `load_T` deep-copies every `List`/`Buffer`/`Map`/`Set` field on *every read*
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
— per matched byte, one interpolation malloc *plus* one whole-accumulator
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
