# STRING_PLAN.md — string-handling performance

> COMPLETE (2026-09-06): all four tranches landed. Standing invariants
> held throughout — full suite green at each landing, kill-switches
> with byte-identical restoration tests, string bench outputs pinned
> byte-identical on both backends. Residual findings live in
> FOLLOWUP.md (plain string assignment aliases; tranche 2's dead-store
> premise falsified, store is load-bearing).

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

REMAINING here — RECEIPT CORRECTION (2026-09-06, falsified): the note
below claimed the per-char `strb w0, [x29,#64]` slot store is dead.
It is NOT: `c` has only 2 reads in json_parse_string (`code`'s init +
the else-branch `append_char` arg) — below the loop-promotion ≥3-reads
threshold AND the NIR allocator's MIN_READS=4 — and its live range
crosses the inline append_char's `_nomen_realloc_wrap` call, which
also disqualifies the caller-saved low-read extension pool. The inline
append_char expansions READ the slot (`ldrb w1, [x29, #64]` at
else_241 in the prebuilt system.s) — the store is load-bearing. Making
it dead requires granting `c` a callee-saved register (eligibility
changes that shipped regressions before — the regex-redux class) for
a bounded 1 instr/char win; the original note ("trace the
inline-return protocol") under-described the gate. PARKED unless a
reads-threshold or inline-arg-marshalling change lands for other
reasons. Original note kept below for the record:

> the per-char `strb w0, [x29,#64]` slot store is dead (c's reads all
> use the promoted x12; the loop-exit store-back reads the register) —
> it survives because the store is emitted before the declare's
> register binding is visible to emit_var_store (the inline-return/
> declare-promotion plumbing). One instruction per char; trace the
> inline-return protocol before attempting.

### Tranche 3 — borrow-position `to_string()` elision — DONE (2026-09-06)

`X.to_string()` where type_from_value_node(X) is `string`, consumed at
a position whose parameter is a plain `string`: pass the receiver's
pair, skip the strdup and the temp free. Call arguments and concat
operands both qualify.

SOUNDNESS GATE (verified 2026-09-05 — the naive form is UNSOUND):
plain `string` params share their bytes with the caller, and
`String.set` takes `ref self` writing through them
(`strb w2, [x19, x1]` — a param variable binds to `ref`). A consumer
that reaches `set` on the param would, with the elision, mutate the
CALLER's original string where the copy semantics previously isolated
it. The elision therefore requires an INTERPROCEDURAL no-mutation
check on the callee for that parameter (scan the callee body —
transitively through its own plain-string-param calls — for `set`/
byte-mutation reaches; cache per function; kill-switch). Console.write,
Regex.count, Json.parse are trivially non-mutating — the hot real-world
consumers. No bench impact expected (corpus to_strings are int
conversions); real-world allocation win and the motivating note's
target. Implement the mutation scan as its own reviewed unit.

LANDED as `src/check/utils/string_mutation_scan.ts` (the reviewed
unit) + a `borrow_to_string` stamp the checker puts on the access_func
and both backends honor:

- **Mark sites** (check pass): call arguments in check_function_call
  (callee param must be plain `string` — no ref/mov/view/variadic;
  marking also skips the usual `_param_N` temp hoist, so no anchor and
  no scope-exit free) and string `+` operands in check_operation_node
  (concat is a read-only consumer by construction — no scan needed).
  The RECEIVER must be an owned `string` via a name/field chain
  (never a call/concat temp — an elided borrow of a temporary would
  leak; and the receiver type matters, not the result type:
  `n.to_string()` on an int produces a FRESH allocation — caught
  during testing, the hoist-skip would have leaked its temp).
- **Mutation scan**: walks the callee AST for byte-mutation reaches on
  the param — direct `ref self` dispatch (`p.set`), forwarding to
  `ref`/`mov` params (the callee would own — and free — the bytes),
  swap, spawn/async capture — and recurses through plain-string-param
  callees (cycle-safe via a visiting set; memoized per
  (function, param) in a WeakMap). Unresolvable callees are
  conservative-mutating. Raw `#arch` bodies are opaque to the AST, so
  textual rules: asm rejects any store/RMW mnemonic or free/mutator
  `bl` target (Console.write — `printf` only, no stores — passes);
  C rejects param indexing/deref, any call taking the param as its
  FIRST argument (C convention: first pointer args are destinations),
  and the byte-writing libc surface (`printf("%s", line)` passes —
  the param is a later argument).
- **Backends**: aarch64 `build_access_method` returns the receiver
  pair (no push/bl/pop, no frees_string_receiver,
  `last_result_is_heap` false); both `is_owned_heap_temp`s return
  false for marked nodes (concat must not free a borrow); C emits the
  receiver expression instead of `string_to_string(receiver)`.
- Kill-switch `set_borrow_to_string_elision_enabled(false)` restores
  the pre-tranche emission (pinned in
  test/borrow_to_string_elision.test.ts).

Receipt (prog: `consume(s.to_string())`, `Console.write(s.to_string())`,
`"x" + s.to_string()`): per site the strdup + hoisted-temp + free
disappear — aarch64 main frame 208→160 bytes, one `bl string_to_string`
total (the owned `var s` decl); C collapses to `consume(s)`,
`Console_write(s)`, `string_add(nomen_str_lit("x",1), s)`. Full suite
green (285 files); string benches byte-identical on both backends
(harness-pinned). Regex.count / Json.parse routes verified non-mutating
by the scan (pure-Nomen forwarding chains); view/mov positions keep
their copies (outside this tranche).

### Tranche 4 — move-on-last-use string assignment — DONE (2026-09-06, re-scoped to declare aliases)

`s = t` where `t` is never read again: skip the strdup, transfer the
pair, mark `t` moved. Requires the checker's last-use analysis to feed
the builders (the `mark_moved_if_struct` precedent exists for `mov`-
explicit structs). Gate: a checker-level last-use receipt on a real
pattern first; do not start without it.

GATE RECEIPT (2026-09-06) — the checker-level analysis exists
(`src/check/utils/last_use.ts`, pinned in
test/last_use_analysis.test.ts) and measures the real pattern:

- The accumulator shape (`var next = acc + part; acc = next` inside a
  loop — the loop-local binding makes the back edge safe) is detected:
  1 site in the real-world-shaped probe.
- Corpus receipts: json-serde / knucleotide / regex-redux and the
  whole core System library contain ZERO `s = t` last-use sites —
  confirming the plan's "real-world allocation win, no bench impact"
  expectation (the win lives in user code, e.g. pre-StringBuilder
  accumulation and staged rebinding).
- Negative controls, all refused: read-after (0), back-edge re-read of
  an outer-loop binding (0), const source (0), sibling-branch read
  (0), non-string and compound assignments (0).

The conservative model: reads textually after the site kill it (sibling
branches included), reads inside an enclosing loop kill it UNLESS the
binding is loop-local (fresh each iteration), spawn/async subtrees are
opaque, and sources must be plain `var` owned-string locals with the
assignment as plain `s = t`. Implementation of the tranche itself
(builder consumption in both backends, moved-marking in the checker
flow, kill-switch + restoration tests) may now start per the gate.

GATE RECEIPT CORRECTION + TRANCHE LANDED (2026-09-06, re-scoped):
building the tranche falsified the ORIGINAL premise — plain `s = t` on
an owned string does NOT strdup on either backend: it pair-copies,
frees the displaced target value, and leaves ownership with the source
(only the source frees at scope exit). The tranche-4 note described the
DECLARE shape. Consequences, verified with probes:

1. The remaining strdup is the declare ALIAS (`var u = t`, the
   is_heap_alias / nomen_str_dup path — "each owned string var must
   have its own copy" so auto_free doesn't double-free).
2. Plain assignment's transfer leaves the source ALIASED-AND-READABLE:
   mutating one visible through the other (probe: `s = t`, write
   through `ref s` → both print the mutation). A value-semantics
   violation recorded in FOLLOWUP.md ("plain string assignment
   aliases") — pre-existing, NOT changed here (restoring the strdup is
   a semantic/perf decision; the mutation gate of tranche 3 keeps
   borrows isolated, so this is reachable only via `ref` on the
   assignee).

LANDED (re-scoped tranche): declare-alias move-on-last-use.

- `last_use.ts` extended: write tracking (an assignment to the source
  after the site refuses the move — the memory-double-free suite's
  alias-then-reassign case caught the first version's gap), declare
  classification (`var u = t`, source `var`-local, owned, zero
  touches after), and a whole-function raw-body refusal (asm/C text
  can touch any local by name).
- `stamp_last_use_moves(root)` runs once per build (semantic stamps on
  the shared AST; cleared by the kill-switch — consumers also check
  the live switch, so toggled rebuilds stay deterministic).
- aarch64: the is_heap_alias branch transfers the pair
  (`ldp/stp`) and moves ownership (`heap_strings.delete(source)` —
  the cleanup frames are gated on the global set, so the source's
  scope-exit free is suppressed).
- C: skips `nomen_str_dup`, records the source in
  `moved_string_vars`, and auto_free skips moved-from strings. The
  source must be an OWNED string (borrow-initialized sources —
  `arr.at(i)` — are refused: freeing a transferred borrow would
  release container memory).
- Kill-switch `set_move_on_last_use_enabled(false)` restores the
  strdup'd copy byte-identically (pinned in
  test/move_on_last_use.test.ts: the transfer, the single-owner free,
  read-after and write-after refusals, and the restoration).

POST-TRANCHE RESOLUTION (2026-09-09): the plain-assignment alias the
corrected receipt exposed was closed by restoring value semantics
(`s = t` strdups) + consuming `classify()` for ASSIGNMENT move
stamps (the transfer this tranche originally scoped). Full writeup
and residuals in FOLLOWUP.md ("Plain string assignment aliases —
FIXED"); pins in test/string_assign_value_semantics.test.ts.

### Standing invariants (every tranche)

1. No regressions across the bench matrix, ±noise (regex-redux is the
   sensitive one — the append_string receipt above).
2. Full suite green.
3. Kill-switch off = byte-identical output for every emitter-side
   change; core `inline` annotations ride the existing inline
   machinery.
4. Behavioral proof: string benches' outputs byte-identical on both
   backends (already harness-pinned in test/bench/).
