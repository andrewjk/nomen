# STRING_PLAN.md — string-handling performance

> Scope: the string-handling path end to end — per-char loops
> (StringBuilder/Buffer consumers), string temporaries and ownership
> copies, and the allocation traffic they generate. Method unchanged
> from the ASM plans: receipts first, interleaved A/B at real bench
> sizes, outputs byte-identical, kill-switches with restoration tests.

## Where the gap actually is (receipts, 2026-09-05)

String-corpus timings (interleaved best-of-5, outputs byte-identical
both backends):

| bench             | ours | C -O2 | ratio |
| ----------------- | ---: | ----: | ----: |
| json-serde n=1000 | 16ms |   9ms | 1.76× |
| knucleotide       |  7ms |   4ms | 1.71× |
| regex-redux       | 24ms |  13ms | 1.92× |

(Absolute times are small — startup is ~2-3ms of each; scale runs below.)

### Sample + census receipts (json-serde, ours)

- `sample` (n large): `.Lsb_ac_grow` (StringBuilder append-char grow
  path) 76+17+10 samples; `StringBuilder_append_char` 18; `_xzm_free`
  machinery present in both backends (~10% of C's profile too — a
  shared cost, not our differential).
- The ours profile is largely UNRESOLVED (recursive parse calls break
  the unwinder), so per-function attribution came from census instead.
- **C inlines `StringBuilder.append_char` — including the realloc grow
  path — into the per-char loop** (clang -O2, `bl _realloc` inside the
  loop body, `strb w26, [x0, x8]` inline). We emitted
  `bl StringBuilder_append_char` per character: the auto-inline
  candidate scan EXCLUDES raw-block methods
  (`is_inline_candidate`: `statements.some(s => s.node_type === "raw")`
  → reject), and every StringBuilder method is a raw `#arch` body.
- **Per-char slot round-trip** in `json_parse_string` (ours):
  `strb w0, [x29, #64]` immediately reloaded by `ldrb w0, [x29, #64]`
  plus a redundant `and x0, x0, #0xFF` (ldrb already zero-extends) —
  ~3 wasted instructions per character of JSON string. The `const char`
  declare is not register-promoted; the frame-slot forwarder cannot
  match the 8-byte store against the 1-byte load (width-mismatch
  conservatism); the `and` is the char read path's explicit masking.
- Interpolation is already single-pass (snprintf measure + malloc +
  render — no concat chain) ✓. Json already routes serialization
  through StringBuilder ✓. Console.write passes the fat pair straight
  through (no copy) ✓.

### Copy-elision audit (the motivating note)

- The corpus benches' `.to_string()` calls are **int→string**
  conversions — semantically necessary allocations. String→string
  copies at ownership boundaries exist but are NOT bench-hot.
- Real-world elision opportunities (checked, real but unbenchmarked):
  1. **Borrow-position `to_string()`**: `Console.write(s.to_string())`
     on a string `s` strdups + frees for nothing when the consumer's
     parameter is a plain `string` (borrow).
  2. **Move-on-last-use string assignment**: `s = t` strdups (value
     semantics — both would own the bytes); if `t` is dead after, a
     move is sound. Requires last-use analysis in the checker.

## Tranches

### Tranche 1 — inline `StringBuilder.append_char` (DONE 2026-09-05)

`pub inline func append_char` — the naked-inline machinery (same path
as `Math.sqrt`) splices the raw body at every call site; the `ref self`
marshal is elided per `naked_inline_skips_self`. json-serde n=5000:
66.5ms vs 68.5ms baseline (+3%); regex-redux neutral. `append_string`
was ALSO tried and REVERTED: +6.3% json but **−8% regex-redux** (the
bigger body inlined at replace_all's call sites bloats the loop) —
kept append_string a call pending per-site cost heuristics.
NOTE: with append_char inlined, json_parse_string's body may now be
call-free, which unlocks the caller-saved float/int ext pools for its
loop promotion — overlapping with tranche 2.

### Tranche 2 — char declare promotion + redundant `and` (next)

The per-char loop's slot round-trip and mask. Two parts:

- The `and x0, x0, #0xFF` after `ldrb` — ldrb zero-extends; the mask is
  redundant whenever the load width is already the type width.
- The `const char c = …` slot round-trip — promotion (register home)
  or width-aware frame-slot forwarding for the sub-width store→load
  pair.
  Receipt: instruction census of json_parse_string before/after; the
  `strb+ldrb` pair must be gone (fails pre-tranche).

### Tranche 3 — borrow-position `to_string()` elision

`X.to_string()` where type_from_value_node(X) is `string`, consumed at
a position whose parameter is a plain `string` (borrow): pass the
receiver's pair, skip the strdup and the temp free. Call arguments and
concat operands both qualify. Soundness note: a borrowed string cannot
be mutated while borrowed (the checker's borrow discipline), so the
copy is unobservable — VERIFY that holds for `string_set`-style
mutation before landing. No bench impact expected (corpus to_strings
are int conversions); it is a real-world allocation win and the
motivating note's target.

### Tranche 4 — move-on-last-use string assignment (largest)

`s = t` where `t` is never read again: skip the strdup, transfer the
pair, mark `t` moved. Requires the checker's last-use analysis to feed
the builders (the `mark_moved_if_struct` precedent exists for `mov`-
explicit structs). Gate: a checker-level last-use receipt on a real
pattern first; do not start without it.

### Standing invariants (every tranche)

1. No regressions across the bench matrix, ±noise (regex-redux is the
   sensitive one — the append_string receipt above).
2. Full suite green.
3. Kill-switch off = byte-identical output for every emitter-side
   change; core `inline` annotations ride the existing inline
   machinery.
4. Behavioral proof: string benches' outputs byte-identical on both
   backends (already harness-pinned in test/bench/).
