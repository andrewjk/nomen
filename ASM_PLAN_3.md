# ASM_PLAN_3.md — the struct-array address pipeline + branch-free limb loops

> Follow-up to ASM_PLAN_2.md (fully discharged: tranches A–H, NIR regalloc
> stages 1–3 default-on, call/field marshalling). Constraint unchanged:
> **the aarch64 artifact stays hand-written assembly — no clang/LLVM in the
> aarch64 build.**
>
> Motivation: pidigits and nbody remain the two worst gaps vs the C backend's
> `clang -O2` artifact. Receipts below measured 2026-09-02.
> **Tranches A and B are DONE; C is DONE** (enablement declined + the mandelbrot unroll corruption fixed); **D step 1 is DONE** (float declaration fast path + `.at()` call-freeness — nbody −44%, ~1.7× vs C), D step 2 (NEON) remains receipt-gated. E is a survey note.

## Where the gap actually is (receipts, 2026-09-02)

Interleaved best-of-5 medians, release builds, outputs byte-identical per
bench (load avg 8–11 during measurement — the box was noisy; arms were
interleaved so the ratios hold):

| bench           | ours (aarch64) | C `-O2` | ratio | unroll flag ON |
| --------------- | -------------: | ------: | ----: | -------------: |
| pidigits n=4000 |         1.08 s |  0.35 s |  3.1× |              — |
| nbody 5M steps  |         0.82 s |  0.21 s |  3.9× | 0.74 s (−7.5%) |

The unroll number matters: the **existing** (default-off) unroller composes
nbody's `advance` double loop and recovers only −7.5% of a 3.9× gap. The
remaining distance is not loop overhead.

### nbody `advance` census (same method as ASM_PLAN_2)

| `advance`        | ours | clang `-O2`                                              |
| ---------------- | ---- | -------------------------------------------------------- |
| instructions     | 351  | 59                                                       |
| FP ops           | 72   | 25 (mixed scalar + `.2d` — the inner loop is vectorized) |
| branches         | 4    | 5                                                        |
| sp touches       | 53   | **0**                                                    |
| `mov x` shuffles | 70   | 3                                                        |

`energy`: ours 196 instrs / 21 sp / 37 `mov x` vs clang 46 / 0 / 3.

What clang did — three things:

1. **The array base, the stride and the induction live in registers.** Our
   body re-derives the whole address per field load (23 sites in one
   `advance`):

   ```asm
   mov x1, x23              ; induction → arg reg
   add x9, x29, #0          ; dead add (overwritten next instruction)
   ldr x9, [x29, #0]        ; array base re-LOADED from its slot
   mov x2, #64              ; stride re-materialized
   lsl x1, x1, #6           ; i*64 recomputed
   add x0, x9, x1
   ldr x0, [x0, #8]         ; bodies.at(i).x
   fmov d13, x0             ; ...then crosses x0 → d13
   ```

   23 sites × 4 redundant instructions = **92 of 351 instructions are
   address re-derivation**, plus **22 `fmov d, x0` domain crossings**
   (float field loads land in x0 first). IMPROVEMENTS.md item 5's "direct
   `[base + i*stride + off]` load" IS firing — but only the final `ldr`;
   everything feeding its address is recomputed, and the result rides x0.

2. **The inner `j` loop is unrolled** (fixed trip `5 − (i+1)`), with each
   body's fields held in registers across the copies.

3. **The unrolled inner vectorizes** to `.2d` pairs (`fsub.2d/fmul.2d/
faddp.2d` over j-pairs). Zero stack touches anywhere in the hot path.

### pidigits receipts

The profile is unchanged since tranche F: **the single-limb `div_to` path**
(`b.len == 1`; pidigits' divisor is one limb) dominates. The loop body is
branchy at the SOURCE level — carries are computed with if-statements
(`core/System/BigInt.nm` lines 573–586):

```nomen
const uint64 p_ll = q_lo * d_lo
const uint64 p_lh = q_lo * d_hi
const uint64 p_hl = q_hi * d_lo
const uint64 p_mid = p_lh + p_hl
var p_mc = 0
if p_mid < p_lh { p_mc = 1 }        // ← branch
const uint64 p_lo_val = p_ll + (p_mid << 32)
var p_lo_c = 0
if p_lo_val < p_ll { p_lo_c = 1 }   // ← branch
```

Every `if` is a block boundary, and block boundaries flush live expression
temps to their frame slots (the phase-2 boundary rule; per-statement
emission has nowhere else to put a value that must survive a branch). The
estimate step therefore round-trips its products through slots _within a
single iteration_:

```asm
mul x0, x13, x12
str x0, [x29, #120]
b.hs end_58              ; the p_mc if — temps flushed
...
ldr x0, [x29, #64]       ; reload an earlier product
mul x0, x13, x0
ldr x0, [x29, #80]       ; reload another
mul x0, x0, x12
```

Stage-3 site keys already cover these consts (single-declared per
iteration) — the slots exist because of the **branches**, not the names.
Clang's limb loop keeps ~10 live scalars in registers because it has no
branches to flush them at: `cset` turns both carry ifs into one flag-form
instruction.

## Tranche A — fixed-array struct access pipeline (nbody) — DONE

Landed 2026-09-02 (`src/build_aarch64/array_licm.ts`, kill-switch
`set_array_licm_enabled`, default ON; `status.array_ptr_cache` +
consume-once `status.at_addr_reg`).

`at(i).field` on a fixed-size array of structs (`Body[5]`, stride 64) gets
a loop-level address pipeline, mirroring what the Buffer data-pointer cache
does for Buffers (fixed arrays don't hit that cache) plus the float side of
tranche H's direct field loads:

- **Cache fill** (the `.at()` fast path, struct elements only): when the
  (array, index) pair — key `"<array>@<index>"`, index restricted to plain
  identifiers — has no pinned register, one is claimed from the x23–x28
  pool (the same exclusions as `alloc_buffer_cache_reg`: promotions, both
  caches, `callee_saved_regs_used`) and `base + i*stride` is computed into
  it once (`add reg, x9, x1, lsl #k` for power-of-two strides, the
  mov/mul/add chain otherwise). Per access the address is `mov x0, reg`
  (the `.at()` contract preserved for every consumer) plus the consume-once
  marker.
- **Field hop** (method-access branch): when the marker is set, the load
  reads `[reg, #off]` instead of `[x0, #off]`; float fields load straight
  into d0 behind the existing `float_result_in_d0` protocol (the same
  caller-wants-d0 dance as the Buffer `load_float` path — x0 still receives
  the value when no float operand requested d0).
- **Stores** (`bodies.at(j).vx = …`): `deferred_field_base_reg` resolves
  the element address through the same cache — no base push/pop, the store
  re-reads the pinned register after the RHS (the same callee-saved
  survival argument as the tranche-H deferred write base).
- **Invalidation**: assignments to the index name or the array name drop
  the affected keys (the loop's `i += 1` update is an assignment, so each
  iteration re-fills exactly once); any non-inlined call drops all entries
  (a ref arg may write the index); while/for clear-and-restore, if/switch/
  match arm-copy, function/method/inline boundaries clear — the identical
  bracketing the buffer cache has.
- **Eligibility** (`fixed_array_cache_key`): `.at` with a single
  identifier index, FIXED length only (a source position on the length —
  dynamic/heap arrays move on realloc and are excluded wholesale),
  non-class struct elements, value or fixed-size-field targets.

Receipts (census, `advance`/`energy` in nbody):

|                | before | after |
| -------------- | -----: | ----: |
| advance instrs |    351 |   226 |
| advance sp     |     53 |    39 |
| advance movx   |     70 |    40 |
| energy instrs  |    196 |   160 |

**RESULT (interleaved best-of-5/7 medians, load avg 13–24, outputs
byte-identical at 1M and 5M):** nbody 5M 0.83 → 0.58 s (**−30%**), now
~2.75× vs C `-O2` (was 3.9×). Bench matrix neutral: pidigits n=2000,
spectral-norm n=1000, fannkuch n=10, mandelbrot n=500 all ±0. Full suite
green (273 files / 2704 tests) with `test/array_licm.test.ts` (5 tests:
fill-once/reuse shape, kill-switch byte restoration, post-loop re-derive
after the index update dropped the pin, store-through-pinned-reg shape
with no base push, behavioral run on both backends) — the shape tests
verified to fail on the pre-tranche compiler.

Remaining in `advance` (next tranches): the per-statement float
declaration-init path still round-trips dx/dy/dz through x0 and slots
(`fmov x0, d0; str x0, [x29, #N]; ldr d1, [x29, #N]`) — float-codegen
work (dest hints for declarations, the tranche-B/C territory), not
address traffic. The unroll composition (tranche C) is now cheap to
revisit: per-copy field reads chain through pinned registers.

Kill-switch off: byte-identical output (the flag gates every consult,
fill, hop change, and store-path change).

## Tranche B — branch-free comparison-assign lowering (pidigits) — DONE

Landed 2026-09-02 (`src/build_aarch64/cset_lower.ts`, kill-switch
`set_cset_lowering_enabled`, default ON; `cond_is_cset_eligible` +
`emit_cond_cset` in build_operation_node.ts; the fuse hooks
`emit_stmt_from_nir`'s declare arm and consumes TWO statements —
`emit_stmt_from_nir` now returns a consumed count that
build_block_node's loop advances by).

`var p_mc = 0; if p_mid < p_lh { p_mc = 1 }` is a materialized boolean.
Pattern-matched at the statement level (NIR cursor): a `var` declare with a
literal-0 scalar init immediately followed by an if with NO else, a single-
statement branch assigning literal 1 to the same name, and a condition that
is a comparison over two plain scalar value nodes (optionally `!`-negated,
parenthesized wrappers unwrapped) →

```asm
ldr x1, [x29, #M]        ; operand homes: slots, promoted regs, literals
ldr x2, [x29, #K]
cmp x1, x2
cset x0, lo              ; unsigned lo/hi/ls/hs, signed lt/gt/le/ge, eq/ne
mov x12, x0              ; store into the site-promoted register or slot
```

No branch, no join label, no block boundary. The declare still builds
(first — every registration/scope semantic preserved); the fused cset
overwrites the dead 0-init. Two occurrences per div_to iteration; removing
them makes the whole estimate step straight-line, which unblocks the
EXISTING machinery (stage-3 site keys + ext pool + int trees) to hold the
products in registers across the iteration.

Soundness gates: operands must be plain scalar value nodes — non-float,
non-literal-pair (literal-vs-literal keeps the constant fold), no calls/no
ref args/no side effects. Compound conditions (`&&`/`||`), float
comparisons, and every special lowering (struct equality, enum tags,
nullable null-checks, strings) keep their branches. The `!` arm recurses
and emits `eor x0, x0, #1`.

Byte-identity harness: the fuse is cursor-dependent (it consumes two
statements), so like NEON/unroll/site-promotion it is held OFF in both
arms of `expect_byte_identical` and the corpus test — the delegation arm
could never reproduce a consumed pair.

Receipts (whole program): carry-carry branches `b.hs/b.lo end_N` 16 → 5
(the remainder are the compound `q_val != 0 && last_nonzero == 0` shapes),
csets 1 → 16.

**RESULT (interleaved best-of-7 medians, load avg 9–23, outputs
byte-identical at n=1000 and n=4000):** pidigits n=4000 1.07 → 0.80 s
(**−25%**), now ~2.3× vs C `-O2` (was 3.1×; ~6.5× at tranche F's start).
Bench matrix neutral: nbody 5M 0.59 → 0.58 (noise), spectral-norm n=1000,
fannkuch n=11, mandelbrot n=1000 all ±0 (outputs identical). Full suite
green (274 files / 2713 tests) with `test/cset_lower.test.ts` (6 tests:
fuse shape, unsigned/signed condition codes, `!` negation via eor,
kill-switch branchy restoration, compound-keeps-branches, behavioral run
on both backends) — the shape tests verified to fail on the pre-tranche
compiler. Static text grew slightly (explicit cset sequences, pidigits .s
90279 → 90119 bytes); the win is dynamic — no branch to mispredict and no
block boundary flushing neighboring products to slots.

Remaining gap to clang's limb loops (honest accounting, unchanged in
kind): cross-statement temporaries are now largely covered, but the
div128 `___udivti3` call boundary still forces callee-saved residency for
everything live across it, and the multiply chains still round-trip the
accumulator through slots where clang chains them. Tranche E (survey) is
the next lever if the post-B profile still shows the call boundary
dominant.

## Tranche C — unroll enablement composed with tranche A (nbody) — DONE (decision: stays OFF)

Closed 2026-09-02. Two outcomes: a **required soundness fix**, and an
**enablement decision backed by receipts** — the composition works but the
value collapsed post-A, and the unroller carries a pre-existing corruption
that bars any default flip.

### The soundness fix (landed)

The array-pointer cache keys on the induction's NAME (`bodies@j`), and in
index-constant unrolling mode the `j += 1` update — the write that drives
the assignment invalidation — is DELETED. Copy k's pin would survive into
copy k+1 with copy k's address. Receipt: the composed build printed
`-1.348342 / 891.903402` instead of `-0.169075 / -0.169088` (nbody 1M).

`build_while_loop_node`'s copy loop now gives each copy a fresh
`array_ptr_cache` (seeded with the enclosing scope's pins — an outer
copy's `bodies@i` stays valid for the whole copy) and releases exactly the
register claims the copy added (the pins die with the copy, so the next
copy re-fills into the SAME registers instead of exhausting the pool into
generic fallbacks). Regression test in `test/array_licm.test.ts`
("unrolled index-constant copies re-derive the pinned address per copy")
— verified to fail on the pre-fix compiler with corrupted output.

### The enablement decision (default stays OFF)

Interleaved best-of-7 medians, nbody 5M, outputs byte-identical at 1M and
5M:

|                  | A      | A + unroll |
| ---------------- | ------ | ---------- |
| nbody 5M         | 0.58 s | 0.56 s     |
| `advance` instrs | 226    | 1385       |

Post-A, the composed unroll is worth **−3.4%** for a **6× code-size
explosion** on `advance`. Tranche A already captured what unrolling was
buying: the slot traffic it used to multiply per copy is gone (pinned
registers chain through copies), and the loop overhead it removes was
already small. The rest of the matrix with the flag on: mandelbrot,
spectral-norm, fannkuch, pidigits (n=2000), binarytrees all neutral.

Worse, the unroller was **broken at HEAD** for mandelbrot with the flag on
— silent wrong checksum. FIXED in this tranche (see below); the enablement
decision still stands on the perf math alone.

### The mandelbrot corruption — root cause and fix (landed)

Bisected with `git bisect run` (unroll-flagged build + checksum diff):
**first bad commit 44e05e79** — ASM_PLAN_2 tranche F's int direct-source
selectors. The mechanism, shrunk to a 30-line repro (unroll on: checksum
1024 instead of 255 — `128 >> bit` with `bit` stuck at 0):

- Index-constant unrolling substitutes the induction's per-copy value via
  `status.induction_const`, consulted by `build_value_node` and
  `build_operand` BEFORE the promoted-register lookup (tranche E's
  contract: the register still holds the PRE-LOOP init during emission).
- Tranche F added five copy-pasted IN-PLACE operand selectors (`int_source`
  in the root int op, `src_reg` in `build_int_tree` and in
  `count_int_tree_allocs`, `promoted_source` in the float op path, `src_reg`
  in `build_float_tree`) that read `register_allocations` DIRECTLY —
  bypassing the `induction_const` check. A promoted induction read as an
  int-op operand therefore returned the stale register value (0) in every
  copy. `build_int_tree`'s version multiplied it: the whole TREE evaluated
  with the stale operand.
- The corruption surfaced only under composed unrolling of a loop whose
  body is an inlined callee (mandelbrot's ×8 `mbrot` expansion) — exactly
  the shape the E-addendum's "outputs identical" receipt predates.

Fix: all five selectors now return null for names in
`status.induction_const`, forcing the operand through `build_operand`,
which folds the copy's constant. The check is a no-op outside unrolled
copies (`induction_const` is only non-empty inside them — flag-gated), so
default builds are byte-identical. Regression test
`test/unroll.test.ts` ("unrolled induction reads fold inside int-op
operands") — behavioral, verified to fail pre-fix with checksum 1024.

Conclusion: the pass stays sound, tested, and available behind
`set_loop_unrolling_enabled` for shapes where it provably pays. The
remaining nbody gap (0.58 vs 0.21 s) is the float declaration-init slot
round-trips in the inner loop — float-codegen work, not loop overhead —
which is the next receipt to chase.

## Tranche D, step 1 (DONE): float declaration fast path + `.at()` call-freeness

The tranche-D gate receipt (post-A/B/C census of `advance` vs clang):
226 instrs / fp 77 / sp 39 / movx 40 vs clang's 59 / 25 / 0 / 3 — still
address/register traffic, not ALU parallelism, so NEON is NOT yet the
lever. Two traffic sources, both fixed here:

1. **Float declaration fast path** (`build_declaration_node`): promoted
   float targets initialize via the float expression tree (call-free
   trees into v16-v31, root in the target) or the float dest hint — the
   declare-side analog of the assignment fast path. Previously EVERY
   promoted-float declaration round-tripped d0 → x0 → dN (nbody's
   dx/dy/dz/mag per inner iteration; the int-side hint landed in
   ASM_PLAN_2 tranche F but the float side only ever covered
   assignments). Unconsumed hints (call/field-read inits) fall back
   through the d0 protocol, mirrored from the assignment path.

2. **`.at()` is call-free** (`tree_is_call_free`): the whitelist knew the
   Buffer accessors by name but treated fixed-array `.at(i)` as a call —
   even though it inlines to a pure strided load (no `bl`). Every
   struct-array loop body therefore failed the call-free gate: no
   extension pools, the reads≥1 bar collapsed to reads≥3, and
   d_sq/dist/mag stayed in slots with every add spilling through [sp].
   Fixed with `at_inline_is_call_free` — the same gate
   build_access_method's inliner uses (fixed length, non-class element,
   value or fixed-size-field target, not a heap array var).

**Census after:** advance 226 → 196 instrs, fp 77 → 59, and the inner
loop's d_sq chain rides the float tree (zero [sp] spills; only the
field-write marshalling keeps its one pre-existing pair). Probe receipt:
`fsub d8, d9, d0` / tree `fmul d16, d8, d8; fadd d11, …` /
`fdiv d13, d10, d16` where the pre-tranche body spilled five times.

**RESULT (interleaved best-of-7, outputs byte-identical at 1M and 5M):**
nbody 5M **0.64 → 0.36 s (−44%)** — now ~1.7× vs C `-O2` (3.9× when this
plan started). Bench matrix neutral (pidigits n=4000, spectral-norm
n=1500, fannkuch n=11, mandelbrot n=1000 all ±0; outputs identical).
Full suite green (275 files / 2716 tests) — one tranche-D-addendum shape
test updated to the new declare shape (it asserted the deleted crossing);
new regression test "struct-array loop bodies are call-free" verified to
fail pre-tranche.

Remaining for D step 2 (NEON) and beyond: the field-WRITE marshalling
spill pair, the fsqrt d0 crossings, and — the gap clang still owns —
vectorization of the inner loop. Receipt-gated as before.

## Tranche D, step 2 — inner-loop NEON for fixed struct arrays (nbody, receipt-gated)

Clang's third win: the unrolled inner vectorizes over j-pairs. Our
vectorizer plans Buffer load/store elementwise loops only; this tranche
extends `plan_vector_loop` with a struct-array element kind (element =
struct stride, field offsets as lane bases, `.2d` lanes over j-pairs).
Per-j terms (`dx*mass_i`, …) are lane-independent; the `A_i` accumulation
is a float reduction → `--fast_math` gated, same as tranche 3.

RECEIPT FIRST: after A+B+C, re-census `advance` vs clang. If the remaining
gap is ALU parallelism (fp ops dominate, stack ~0), vectorize; if it is
still address/register traffic, fix that first. Tranches 5/6's closed
candidates (`shifted indices`, byte kinds) stay closed — this is a
different element kind, not a reopened one.

## Tranche E (survey note, not planned): the div128 boundary

`div128` lowers to `___udivti3` — a real call, so everything live across it
must be callee-saved (correct today, and the pool is the constraint the
per-limb loops feel). If the post-A/B pidigits receipts still show the call
boundary dominating: (a) Newton–Raphson reciprocal or `umulh`-based
division in raw asm (counted a loss for NEON in ASM_PLAN_2, unanalyzed for
scalar), or (b) `#arch: aarch64` inline asm for the estimate step. Survey,
measure, then decide — do not start here.

## Method (unchanged from ASM_PLAN_2)

Per bench: emit both artifacts (`bench/compile_nomen.ts`, aarch64 + `c`
then `clang -O2 -S` on the C), extract hot functions by label
(`^name:` ours; `^_name:` clang's; beware inlining + multi-exit slicing),
census (instrs / FP ops / branches / sp touches / mov shuffles), read the
bodies side by side, THEN time at the real bench size interleaved
best-of-N with output diffing. The census script is ~60 lines of tsx
(lives in this document's history — the 2026-09-02 session's copy was a
throwaway in `$TMPDIR/plan3/census.ts`).

Machine discipline: load avg hit 8–11 during the receipts session. Never
trust a single run; interleave arms; medians of ≥5.

## Success criteria

Written before any tranche lands:

- pidigits n=4000 and nbody 5M within **1.5×** of the C `-O2` artifact, or
  a written structural blocker per remaining multiple.
- Standing invariants (unchanged): no regressions across the rest of the
  bench matrix; full suite green; every kill-switch off = byte-identical
  output.
- Each tranche lands with: census before/after, interleaved A/B timings,
  behavioral output-identical proof, and tests that fail on the pre-tranche
  code.
