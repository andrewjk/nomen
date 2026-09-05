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

### Tranche 2 — char declare round-trip + redundant `and` — DONE (neutral perf, codegen win)

Landed in `asm_opt.ts` (widen-mask pass has its own kill-switch
`set_widen_mask_elimination_enabled`; the frame-slot elide rides
`optimize_frame_slots`):

- **Frame-slot reload elide**: a load from a slot whose PENDING store
  came from the SAME register is redundant — the register still holds
  the stored bytes. Full-width (str/ldr xN) is exact; sub-width
  (strb/ldrb) requires a per-register zero-extension fact (ldrb/ldrh/
  ldr-w set it, defs kill it, stores/compares preserve) — the
  reload's zero-extension of the upper bits is an observable register
  change, and eliding without the fact corrupted class-move's
  ownership slot (the pick receipt, audit trap exit 133). Second
  receipt from the same feature: an elided load left the store
  PENDING, and the next flush re-positioned it after the epilogue —
  writing through the caller's restored x29. Stores now commit at
  their original position when the load is dropped.
- **Redundant widen-mask elimination**
  (`eliminate_redundant_widen_masks`): `and xN, xN, #0xFF` after a
  zero-extending `ldrb wN` (the checker's char→int comparison
  promotion) is an identity — same zext-fact tracking, covering
  NON-frame loads too.

json_parse_string's per-char sequence: 7 → 4 instructions
(`ldrb w0,[x0,x1]; strb w0,[x29,#64]; mov x12, x0` + index mov).
Bench: NEUTRAL on json-serde (±1%) — the loop is dominated by the
escape-switch dispatch and the remaining append_string call. Kept as a
strict instruction-count win (applies corpus-wide to every char/short
compare).

REMAINING here: the per-char `strb w0, [x29,#64]` slot store is dead
(c's reads all use the promoted x12; the loop-exit store-back reads
the register) — it survives because the store is emitted before the
declare's register binding is visible to emit_var_store (the
inline-return/declare-promotion plumbing). One instruction per char;
trace the inline-return protocol before attempting.

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
