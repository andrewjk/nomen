# ASM_PLAN_3.md — the struct-array address pipeline + branch-free limb loops

> Follow-up to ASM_PLAN_2.md (fully discharged: tranches A–H, NIR regalloc
> stages 1–3 default-on, call/field marshalling). Constraint unchanged:
> **the aarch64 artifact stays hand-written assembly — no clang/LLVM in the
> aarch64 build.**
>
> Motivation: pidigits and nbody remain the two worst gaps vs the C backend's
> `clang -O2` artifact. Receipts below measured 2026-09-02.
> **Tranche A is DONE** (see its section for the measured result); B–E open.

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

## Tranche B — branch-free comparison-assign lowering (pidigits)

`var p_mc = 0; if p_mid < p_lh { p_mc = 1 }` is a materialized boolean.
Pattern-match it at the statement level (NIR cursor): a declare-to-0
immediately followed by an `if` whose condition compares two pure scalar
operands and whose (only) branch assigns literal 1 to the same name →

```asm
cmp xN, xM
cset xK, lt
```

No branch, no block boundary, no flush. Two occurrences per div_to
iteration; removing them makes the whole estimate step straight-line, which
unblocks the EXISTING machinery (stage-3 site keys + ext pool + int trees)
to hold `p_ll/p_lh/p_hl/p_mid/p_lo_val` in registers across the iteration —
no new allocator work required.

Soundness: operands must be pure scalars (no calls, no ref args, no
possible side effects) — anything else keeps the branches. The pattern
generalizes to `if c { x = 1 }` / `if !c { x = 1 }` with the declare
immediately preceding; anything more complex rejects.

Kill-switch: `set_cset_lowering_enabled`.

## Tranche C — unroll enablement composed with tranche A (nbody)

The pass exists, is sound, tested, default-off (ASM_PLAN_2 tranche E
addendum: composed outer-first unroll of advance measured −6…−7.5% BEFORE
tranche A). With A landed, re-measure:

- If A+unroll compose well (expected — copies multiply slot traffic today,
  register traffic after A), decide the enablement shape: a bench-harness
  flag, `--unroll` on the CLI, or an automatic heuristic (loop not a serial
  dependence chain — the mandelbrot counter-example is documented). Do NOT
  flip the global default without the full bench matrix.

## Tranche D — inner-loop NEON for fixed struct arrays (nbody, receipt-gated)

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
