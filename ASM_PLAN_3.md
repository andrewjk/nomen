# ASM_PLAN_3.md — the struct-array address pipeline + branch-free limb loops

> Follow-up to ASM_PLAN_2.md (fully discharged: tranches A–H, NIR regalloc
> stages 1–3 default-on, call/field marshalling). Constraint unchanged:
> **the aarch64 artifact stays hand-written assembly — no clang/LLVM in the
> aarch64 build.**
>
> Motivation: pidigits and nbody remain the two worst gaps vs the C backend's
> `clang -O2` artifact. Receipts below measured 2026-09-02.
> **A, B, C are DONE** (C: enablement declined + the mandelbrot unroll corruption fixed); **D step 1 is DONE** (nbody −44%, ~1.7× vs C) and **D step 2 is CLOSED** (analyzed: j-pair vectorization unprofitable for AoS; clang's win is field-pair SLP — a future pass class). **E is DONE as a survey** (the div128 boundary does not dominate post-B; neutral, reverted). **F is DONE as a narrow win + survey** (stage-4 straight-line store-to-load forwarding + write-only cset elision: real capture on the single-limb shapes, bench-neutral — the profile has moved to multi-read temporaries; see the F section for the structural accounting). **G is DONE** (promoted-destination statement lowering: cset dest hints + the never-firing compound-assign fast path fixed — pidigits −8%, fannkuch +2-4%). **H is DONE as cap lift + CLOSED survey** (callee pool to the full x23–x28 — clean, neutral; the loop-invariant re-baring half was reverted with a forensic finding: the inline-expansion seed drops caller claims — mandelbrot hang at n=16, see the section). **I is DONE** (float-bits forwarding — nbody −10%, at the 1.5× target). **J is DONE as a narrow win + survey** (flag-form carry lowering: `adds`/`cinc` folds in the Knuth-D loops — pidigits −4.8%; the loops are now accessor-address bound, see the J survey). **K is DONE as a survey** (inline Buffer address pipeline — correct but neutral, reverted to OFF; the remaining gap is the per-statement `x0` staging model, see the K survey). All measured receipts in-section.

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

## Tranche D, step 2 — inner-loop NEON for fixed struct arrays — CLOSED (analyzed, wrong transform)

The gate receipt was earned (post-D1 census: 196 instrs / fp 59 / sp 35 vs
clang's 59 / 25 / 0), but reading clang's actual `advance` kills the
planned transform. What clang ships is NOT lanes-over-j:

```asm
ldr q4, [x11, #32]        ; (bj.vx, bj.vy) — ONE q-load, fields as lanes
fsub.2d v16, v2, v16      ; (dx, dy)
fmul.2d v17, v16, v16     ; (dx², dy²)
faddp.2d d17, v17         ; dx²+dy² horizontal
fsqrt d17, d7             ; sqrt stays SCALAR
fsub.2d v4, v4, v19       ; (bvx, bvy) -= dx*mag, dy*mag
str q4, [x11, #32]        ; one q-store
add x9, x9, #64; subs x13, x13, #1; b.ne   ; the j loop REMAINS a loop
```

Two conclusions:

1. **Lanes-over-j (the planned `plan_vector_loop` extension) is
   unprofitable for AoS struct arrays.** `{x_j, x_j+1}` are 64 bytes
   apart: each field-pair gather costs `ldr d; ldr d; ins v.d[1]` (3
   instructions) to save one 2-wide fp op. Counting nbody's inner body:
   ~21 gather instructions per pair against ~26 scalar fp ops halved —
   the gather eats the win before the RMW stores and reductions pay
   anything. Clang doesn't do it either.
2. **Clang's win is field-pair SLP within ONE body** — (x,y) and (vx,vy)
   as `.2d` lanes, `faddp` for the horizontal sum, q-load/q-store of
   adjacent field pairs. That is a different pass class (superword-level
   pattern matching over consecutive statements), not an extension of the
   induction-driven loop vectorizer. And it is layout-gated: clang's C
   structs have no 8-byte prefix, so its (x,y) pair sits at #0; Nomen's
   vt-prefix layout puts x@8/y@16, which the Q-form LDR immediate cannot
   even encode (offsets must be multiples of 16). The usable Nomen pairs
   are (y,z)@16 and (vx,vy)@32 — the win shrinks to the vx/vy update
   slice.

CLOSED as analyzed-unprofitable for the loop vectorizer. The honest
remaining lever for nbody is a field-pair SLP pass — its own project, on
the order of the NEON vectorizer itself, gated on a receipt showing the
instruction-count delta (~35 vs ~55 per body) survives Nomen's prefix
layout. nbody stands at ~1.7× vs C `-O2`.

## Tranche E (DONE — survey): the div128 boundary does not dominate

The premise ("`div128` → `___udivti3` is a real call and the per-limb
loops feel the pool constraint") predates tranche B. Measured directly:
the full Granlund–Montgomery replacement — normalize once, hoist
`m = invert_limb(d_norm)` via one `div128` call, per-limb
`umulh(m, n_hi) + n_hi` estimate (GM Thm 4.2, error ≤ 2) made exact by a
bounded self-validating remainder correction with the library call as a
fallback — swept **correct on 176 divisor×dividend cases on both
backends** (`test/bigint_single_limb.test.ts`, cross-backend +
in-program `a == q·d + r` verification) and measured **perf-neutral**:
pidigits n=4000 0.84 → 0.84 s, outputs identical.

That is the survey answer: **post-B, the call boundary is not the
bottleneck.** Tranche B's cset fuse flattened the profile (the ASM_PLAN_2
tranche-F accounting was taken before it); the remaining time is smeared
across the limb loops' memory traffic and residual per-statement costs,
none of which a faster div128 touches. The implementation was reverted
(neutral perf does not buy complexity in the core library — the
`Buffer.data` LICM precedent); the sweep test stays as a division
regression test.

pidigits stands at ~2.3× vs C `-O2`. The remaining distance is the same
structural accounting as stage 2/3's: clang's limb loops keep ~10 live
scalars in registers through memory traffic our per-statement model
still materializes — the next lever there would be NIR-level store-to-load
forwarding across straight-line regions (stage 4), not division.

## Tranche F (DONE — narrow win + survey): stage-4 straight-line store-to-load traffic elimination

Landed 2026-09-02 (`src/build_aarch64/forward.ts`, kill-switch
`set_forwarding_enabled`, default ON; `prepare_nir_forwarding` runs once per
published emission cursor from build_function_node and build_body_with_cursor;
the cset fuse consults `ctx.write_only`, the emitter applies
`ctx.use_sites`/`ctx.forward_defs` per statement).

The premise from E's tail: "the next lever there would be NIR-level
store-to-load forwarding across straight-line regions (stage 4)". The census
confirmed the traffic — in the inlined single-limb `div_to` loop, three
single-read locals round-trip their slots every iteration
(`str x0, [x29, #K]` at the def, `ldr x0, [x29, #K]` at the only read: d_hi
#64, q_hi #80, ai #40), the phase-2 asm pass unable to help because the
store's source register is clobbered in between — plus two WRITE-ONLY cset
flags (p_mc/p_lo_c, their reader commented out at BigInt.nm line 587):
`mov #0; cmp; cset; str` pairs materializing a boolean nothing reads.

Two cursor-level rewrites, both gated on one traffic walk:

- **Single-use forwarding**: a scalar declared exactly once, read exactly
  once, never written/ref/receiver, whose initializer is a pure int
  expression tree (bounded size/depth) is re-emitted AT the read site — the
  use's NIR leaf and its AST node are replaced by the declaring initializer
  (apply → build → restore, one statement at a time), and the def emits
  nothing. Soundness = every leaf of the re-emitted tree holds its def-time
  value: the use must be in the SAME statement list, every intervening
  statement a declare with a call-free initializer, no redeclares of any
  name in play, no window declare whose site register collides with a
  promoted leaf's register (the div_to two-claim-systems receipt), no
  checker-hoisted allocations reading any of it (`_param_N` computes are
  invisible to NIR traffic — interpolation lowers to a spliced
  `_param_1 = prod` leaf plus a hoisted compute), and the forwarded name
  occurs as a leaf EXACTLY once in the whole function counting positions
  traffic deliberately skips (flow arms, spawn calls, swap exprs).
  Candidates whose own initializer already received a splice are dropped
  (composition guard), and so are promoted names (they already avoid the
  slot). The rewrite happens BEFORE emission, so the tree counter, operand
  selectors and cset homes all see a plain deeper tree — no read path
  learns about forwarding.
- **Write-only cset-pair elision**: the tranche-B fuse whose flag has zero
  true reads (traffic's assign-target parity subtracted) skips the whole
  cmp/cset/store tail; the declare still builds (registration semantics
  preserved).

Receipts (the inlined single-limb `div_to` loop, per iteration):
`str`/`ldr` #64 and #80 gone (use-site re-emit: `mov #32; ldr divisor;
lsr` and `mov #32; lsr x0, q_reg` — q's promoted register read in place),
both dead cset pairs gone — **−16 instructions and −5 memory ops per
iteration of the ~75-instruction loop; frame 944 → 928 bytes.**

**RESULT: bench-neutral.** Interleaved best-of-7/11 medians, outputs
byte-identical at every size: pidigits n=4000 0.8167 → 0.8167 s (0.0%),
nbody 5M 0.3514 → 0.3513 (0.0%), spectral-norm 1500 +0.8%, mandelbrot 1000
+1.3%, fannkuch 11 −1.0%/+0.6% (arms swapped: pure noise), binarytrees 15
+0.5%. Full suite green (276 files / 2721 tests) with `test/forward.test.ts`
(7 tests: shape via use-site anchors, write-only elision, kill-switch
byte-restoration, branch-boundary window rejection, shadowing rejection,
two behavioral runs incl. loop re-execution).

### The survey answer: why neutral, and what actually remains

`sample` on a running pidigits shows the profile MOVED: the hot loops are
now div_to's **Knuth-D section** (D1 normalize, D3 correction, D4
multiply-subtract) and **mul_to's schoolbook inner loop** — not the
single-limb estimate step this tranche captures. Those loops' temporaries
are genuinely MULTI-read, and multi-read-by-a-compare is their shape:

```nomen
const uint64 old = scratch.get_at(scratchp, j + i)   // 2 reads
const uint64 cur = old + carry                        // 2 reads
var c1 = 0
if cur < old { c1 = 1 }                               // the compare IS the second read
const uint64 cur2 = cur + lo_prod                     // 2 reads
```

The allocator already keeps those in registers (ext pool/site promotion);
forwarding is unprofitable-by-absence. The structural lever they expose is
a compare-shape lowering that reads the operands from the VALUE computations
without materializing the compare inputs twice — i.e. flag-producing
compares consume SSA values directly (`cmp x_cur, x_old; cset`) — which is
a NIR value-numbering/regalloc-cooperative pass class, one order larger
than this tranche. That, plus nbody's field-pair SLP (D step 2's
conclusion), are the honest remaining levers against the 1.5× success
criterion: pidigits' residual ~2.3× is smeared across Knuth-D memory
traffic our statement model must materialize; nbody's ~1.7× is the SLP gap.

The pass stays (default ON, kill-switch off = byte-identical): it is
non-negative everywhere, removes the documented round-trips wherever
single-read shapes occur, and is the seam a future value-numbering pass
would drive.

## Tranche G (DONE): promoted-destination statement lowering

Landed 2026-09-02 (build_operation_node's `emit_cond_cset` takes a
`dest_reg`; build_assignment_node's literal-compound fast path fixed;
emit_nir's cset fuse resolves the flag's home). No new kill-switch — the
cset fuse and plan-2-F fast path are the existing toggles.

F's survey said the remaining limb-loop temporaries are multi-read "by the
compare". Reading the actual mul_to single-limb loop and add_to/sub_to
bodies against the emitter found two concrete statement-level leaks:

1. **The plan-2-F literal-compound fast path NEVER fired.** It checks
   `node.operator === "+"`, but compound assignments carry the two-char
   token the parser stores (`"+="`, `"-="`) — `i += 1` on a promoted i
   emitted the generic 4-instruction sequence (`mov x1, xI; mov x0, #1;
add x0, x1, x0; mov xI, x0`). Fixed by matching the token form; the
   fast path now folds to `add xI, xI, #imm`.
2. **The tranche-B cset fuse staged every flag through x0 twice**: the
   declare's dead 0-init (`mov x0, #0; mov xN, x0`) plus the cset result
   staging (`cset x0, cc; mov xN, x0`) — 4 wasted instructions per flag
   even when the flag's home is a promoted register. Now a flag whose home
   is a promoted register takes `cset xN, cc` directly and the declare
   emits nothing (the 0-init is dead under B's own contract — the fused
   cset overwrites it before any read; frame slots allocate at
   declare-emission, so the skip is only sound for register homes, which
   is exactly when it pays). Slot-home flags and swap-bearing declares
   keep the full builder path.

The same F-session census had also flagged this loop's `adr x1, carry`
assembler failure — caught by the build validator, never shipped: the
first A2 attempt skipped the declare unconditionally, stranding slot-home
flags (the declare allocates their frame slot). The guard above is the
fix.

Census (mul_to single-limb loop, per iteration): c1 7 → 2 instructions,
the `i += 1` update 4 → 1; loop ~62 → ~54 lines. The same shapes carry in
add_to/sub_to's carry chains and div_to's Knuth-D updates.

**RESULT (interleaved best-of-7/11 medians, load 3–12, outputs
byte-identical at every size and bench):** pidigits n=4000 **0.8345 →
0.7684 s (−7.9%, reproduced 8.0%**, now ~2.2× vs C `-O2`), pidigits n=1000
−6.6%, fannkuch 11 +1.9% to +4.5%, nbody 5M −1.7% to −2.0%; spectral-norm,
mandelbrot, binarytrees neutral (the negative readings flipped sign with
arm swap — noise). Full suite green (277 files / 2729 tests) with
`test/promoted_dest.test.ts` (5 tests: dest-hint shape, slot-home
unchanged, cset kill-switch restoration, compound imm12 fold + 4096
fallback, behavioral) and the two tranche-B cset shape tests updated to
the dest-hinted canonical form (they asserted the deleted x0 staging).

## Tranche H (DONE — cap lift; CLOSED survey): the callee pool and the loop-invariant slot loads

Landed 2026-09-02 (`nir_regalloc.ts`: MAX_X_CALLEE 4 → 6, kill-switch
`set_nir_callee_pool_extended` default ON; OFF restores the legacy cap
byte-identically). The re-baring half of the tranche was REVERTED the same
session — forensics below.

The G-session census flagged the last obvious memory traffic in the limb
loops: loop-invariant locals re-read from their frame slots EVERY
iteration (`bp` #56 and `sp` #24 in mul_to's single-limb loop, `divisor`
#0 three times in div_to's). Why they stay slots: (a) their live ranges
span a loop header → `loop_blocked` → the caller-saved ext pool is
forbidden; (b) their raw textual reads (1–3) sit below MIN_READS=4, and
the low-read extension also requires a loop-free-contained range; (c) the
callee-saved pool cap of 4 was already consumed by the loop's hotter
state (i/carry/sv/other_len). Pool depth and the read bar, in that order.

**What landed: the cap lift.** `MAX_X_CALLEE` 4 → 6. The legacy cap kept
x27/x28 "available" to loop promotion and the Buffer/array caches — but
every runtime claimant already excludes `callee_saved_regs_used`, so
plan-claimed registers are respected and the reservation was pure
conservatism. The prologue patching (fn_callee_saved →
callee_saved_regs_used → save/restore) picks the extra claims up
automatically, for functions and seeded method bodies alike. Receipt: 4+
-read candidates that previously missed the cap take x27/x28 (mul_to
loses one slot store; the shift is visible in the assignment ordering).
**RESULT: bench-neutral** (interleaved best-of-7/11, load 3–30,
outputs byte-identical on all six benches: pidigits ±0.5%, fannkuch
−0.4%, nbody ±0, spectral −0.1%, mandelbrot +0.7%, binarytrees +1.6% —
no directional signal; full suite 277 files green). Kept: zero-risk pool
depth for future passes, byte-clean kill-switch.

**What was reverted twice, then LANDED: the loop-invariant re-baring.**
Admitting low-read loop-spanning names into the callee pool via
loop-weighted traffic (`weighted_reads >= 8`, never-written gate,
update-walking write scan) captured the real targets — div_to's
`divisor` promoted (3 slot loads/iteration gone), mul_to's `sp`/`bp`
promoted — and **mandelbrot hung at n=16**. Two forensic sessions
compressed:

- The hang needed TWO expansion-path fixes, both real bugs on their own:
  1. **Loop promotion's caller-saved ext claims were invisible to
     inline expansions** (`register_allocations` cleared at expansion
     entry; `callee_saved_regs_used` deliberately excludes ext regs;
     `nir_caller_saved_claimed` tracked only the function-plan's ext
     claims). With the bar's extra plan claims pushing the expansion's
     promotion into the ext range, it reclaimed the enclosing bit-loop's
     live `byte_val=x13`. **Fixed**: loop promotion records its
     ext-pool claims in `nir_caller_saved_claimed`, which the expansion
     consults.
  2. **The expansion swapped `function_param_types` to an EMPTY map**,
     so the inlined method's FLOAT params promoted through the
     unknown-type-int default (mbrot's `ci=x15` — the documented
     ci/cr receipt re-entering through the expansion door). **Fixed**:
     both inline paths now fill the fresh map with the inlined
     function's own param types.
- The first re-land then failed the suite's own shadowed-local
  regression: the write-free scan walked the RAW lowering, whose assign
  targets are plain names, so a shadowed site checked against them
  looked never-written (`x@0` admitted; the shadow's writes landed in
  its register). **Fixed**: the scan walks the RENAMED body — targets
  carry their decl-site keys, and the gate is per-site exact.

**LANDED RESULT (interleaved best-of-7/11, outputs byte-identical on
all six benches at multiple sizes):** pidigits n=4000 +1.2% (the
divisor's 3 loads/iteration gone), mandelbrot +4.0% (param-type fix
+3.1% measured separately), nbody/fannkuch/spectral/binarytrees neutral.
div_to's hot loop: 5 → 2 frame references; mul_to's: 3 → 1. Full suite
green (277 files / 2727 tests) — the suite's own shadowed-local
regression test caught the renamed-writes bug (it failed on the first
re-land), and a behavioral test pins the expansion float-param shape.

## Tranche I (DONE): float-bits forwarding — the d0 protocol's crossings collapse

Landed 2026-09-02 (`asm_opt.ts`: `run_float_forwarding` = consumer rewrite

- dead stage-move elimination, kill-switch `set_float_forwarding_enabled`
  default ON; wired into build.ts after the frame-slot pass, same
  unconditional + asm-validated contract).

The D2 leftovers in nbody's `advance` census: `Math.sqrt` completed a
quadruple conversion — `d29→x0→d0→fsqrt→d0→x0→d30` — five instructions
around one `fsqrt`, plus the field-write staging (`fmov x0, d0; mov x2,
x0; str x2, [x26, #32]`). The residue is the d0 call protocol: D1 fixed
the declare/assignment crossings; CALLS still stage float bits through
integer registers.

The pass, two linear scans over the lifted assembly:

- **Consumer rewrite (forward)**: a `fmov xN, dM` records "xN holds dM's
  bits"; a later `fmov dK, xN` with the record live rewrites to
  `fmov dK, dM` (self-moves drop). Records die at labels (join
  provenance), on any redefinition of xN, AND on any redefinition of dM
  — the staleness case that first landed broken (a consumer rewritten to
  read d8's NEW value after d8 was reassigned produced `-inf`; the
  output diff on nbody's energy caught it before anything shipped).
- **Dead producer elimination (backward)**: a `fmov xN, dM` whose xN is
  never read below is a dead staging move. Its live set needed an exact
  AArch64 defs rule (dest-first, two for ldp) — the shared `instr_defs`
  over-approximates (safe for invalidation, but there it counted every
  reg-only op's sources as defs and hid reads) — plus explicit call-arg
  reads (bl reads x0–x8/d0–d7/x30; the lifted call text carries only the
  target). Pruning is forbidden across labels (the live set resets to
  the universe).

Receipts: nbody's sqrt block is now `fmov d0, d29; fsqrt d0, d0; fmov
d30, d0` (5 → 3, both leftovers pruned). **RESULT (interleaved
best-of-7/11, outputs byte-identical on all benches):** nbody 5M
**0.3496 → 0.3141 s (−9 to −10%, reproduced — now ~1.5× vs C `-O2`,
the success-criteria target)**, mandelbrot +5.8%, spectral +1.6%,
pidigits +0.8%, fannkuch/binarytrees neutral. Full suite green (277
files / 2730 tests) with three tests: the collapse shape, kill-switch
byte restoration, behavioral exactness.

## Tranche J (DONE): flag-form carry lowering — the compare-shape lever, narrow form

Landed 2026-09-02 (`src/build_aarch64/flag_form.ts` kill-switch
`set_flag_form_enabled`, default ON; `try_emit_carry_fold` in emit_nir.ts
rides the declare dispatch BEFORE the tranche-B fuse; `adds`/`subs`/`cinc`
added to the asm validator's mnemonic table — condition codes reuse the
existing `hs`/`lo` aliases of `cs`/`cc`).

F's survey named the lever: "flag-producing compares consume SSA values
directly (`cmp x_cur, x_old; cset`)". The sample profile says where it
pays: ~60% of pidigits is div_to's Knuth-D section (D3 correction loop
39%, D4 multiply 17%, D4 subtract 27% of the hot samples at n=12000).
Every one of those loops computes carries the same source shape:

```nomen
const uint64 prod = a + b        // or a - b (the D4 borrow)
[plain assign: mul_carry = hi_prod]   // the intervening statement
var c = 0
if prod < a { c = 1 }            // — or —  if prod < a { mul_carry += 1 }
```

`prod < a` after `a + b` IS the carry flag (and `prod > a` after `a - b`
IS the borrow), so the whole compare — cmp plus its two operand stagings
plus the branch for the compound-assign form — collapses into the
declare's own arithmetic:

```asm
adds x12, x13, x26        ; the declare's root op, flags set for free
mov  x26, x14             ; the intervening assign (flag-safe: mov/str only)
cinc x26, x26, hs         ; was: cmp + 2 stagings + b.hs + add (clang's idiom)
```

Two forms, one matcher (consumes 2-4 NIR/AST statements):

- **Form A** — the tranche-B zero-flag pair, reached through the fold: the
  cset fires from the adds/subs flags with NO cmp. Form B's tails (G dest
  hints, F write-only elision) stay authoritative: the fold declines and
  lets the B fuse handle them when the flag is dead or a slot-home.
- **Form B** — `if cmp { x += 1 }` on an existing scalar: `cinc xH, xH, cc`
  on a register home; `cset x0 + load/add/store` on a slot home (mul_carry
  in D4 has no register — the pool is exhausted).

The declare is emitted DIRECTLY (promoted operands used in place via the
int fast-path selector contract — params and unrolled-copy inductions
excluded, the mandelbrot receipt; others stage through build_operand) —
NOT via a one-shot emitter arm: build_declaration_node provably builds an
initializer more than once (first emission discarded), so any consumed-
once global arm mis-fires (tried, debugged via stack traces, reverted the
same session). Skipping the builder for a register home is the G-tranche
precedent; slot-home prod declines the whole fold.

Soundness gates: unsigned only (`<` over `+` and `>` over `-` are the
carry/borrow flags; signed overflow is not — `int` operands decline and
keep cmp/cset lt); `==`/`!=`/`<`-after-`-`/`>`-after-`+` decline; the
intervening statement (at most ONE) must be a plain `name = name|literal`
scalar assign with no compound operator and not writing prod — mov/ldr/str
are the only instructions the window may emit between the flags and the
consumer; no else, single-statement branch; swap-bearing declares decline;
forward-use splices are applied around the consumed intervening assign
(ifs and literal-1 assigns cannot be splice hosts).

Byte-identity harness: cursor-dependent (consumes up to four statements),
so like B/F/G it is held OFF in both arms of `expect_byte_identical` and
the corpus test.

Receipts (loop bodies, source lines per iteration; the first number is the
pre-J committed build):

| loop (pidigits)                  | before | after |
| -------------------------------- | -----: | ----: |
| div_to D3 correction (.while_22) |     43 |    38 |
| div_to D4 multiply (.while_24)   |     50 |    43 |
| div_to D4 subtract (.while_25)   |     69 |    61 |
| mul_to single-limb (.while_9)    |     46 |    46 |
| mul_to schoolbook (.while_12)    |     66 |    62 |

The carry compares are branch-free in all five loops (b.hs/b.lo carry
branches 5 → 3 whole-program; the remainder are the compound
`q_val != 0 && last_nonzero == 0` shapes).

**RESULT (interleaved best-of-45 medians, outputs byte-identical at
n=1000 and n=4000):** pidigits n=4000 0.7202 → 0.6855 s (**−4.8%**),
n=1000 −4.6% (reproduced at both sizes). Bench matrix: nbody,
spectral-norm, fannkuch, mandelbrot, binarytrees assemble to
**byte-identical .s** (the shape cannot fire without a BigInt carry
loop — structurally regression-free; output diffs on their binaries are
LC_UUID link randomness). Full suite green (279 files / 2740 tests) with
`test/flag_form.test.ts` (9 tests: adds+cset-hs shape, subs+cset-lo,
adds+cinc Form B, negation via inverted cc, kill-switch byte restoration,
signed-declines, no-flag-equivalent-declines, arithmetic-intervening
declines, behavioral on both backends) — the shape tests verified to fail
on the pre-tranche compiler (4 of 9 under `git stash` of the two emitter
files). Two tranche-G shape tests updated to the new canonical form (they
asserted `cset …, lo` where the same source now fuses to `adds` +
`cset …, hs`).

### The survey answer: what remains in pidigits

The win is real but bounded: the Knuth-D loops are now ADDRESS-TRAFFIC
bound, not compare-bound. Per D4-subtract iteration (~61 lines), ~30 are
inline-accessor address derivation: each `remainder.digits.load_int/
store_int` re-derives `wd_off + u_len + 1 + i` (with 2-3 loop-invariant
slot loads inside) and RE-LOADS the `digits` data pointer (3 instructions)
— clang's `str x10, [x20, x12, lsl #3]` is one instruction. The tranche-A
array pipeline does not reach inline Buffer accessors on nested receivers
(`remainder.digits`), and the x23–x28 cache pool is already exhausted in
div_to. The next lever there is an accessor-address pipeline for inline
Buffer accessors (hoist the receiver's data pointer + the loop-invariant
index summands), or widening the cache pool again — both their own
tranches, receipt-gated on this census. pidigits stands at ~2.1× vs
C `-O2` (was ~2.2×); nbody holds at ~1.5×.

## Tranche K (DONE — survey): inline Buffer address pipeline does not pay

Landed as a survey 2026-09-02 (`src/build_aarch64/buffer_pipeline.ts`,
kill-switch `set_buffer_pipeline_enabled`, default OFF; `tryHoistBufferAddrs`
in `build_while_loop_node` preheader, `buffer_base_cache` + `buffer_data_cache`
seeding, `build_access_node` index rewrite to `add x1, baseReg, indReg`).

The J survey named the lever: Knuth-D loops are now address-traffic bound
(~30 of ~61 instructions per D4-subtract iteration are `remainder.digits`
address re-derivation: 2-3 loop-invariant slot loads + 2 adds for the
index sum + 3 for the data pointer). The existing `buffer_data_cache`
dedups within a straight line but is cleared on entry to every `while`,
so each outer iteration refills and under Knuth-D pressure the x23-x28
pool is exhausted.

The pipeline hoists both parts loop-invariant per `while`:

- the Buffer's data pointer (one callee-saved register per distinct
  `remainder.digits` target that is not written inside the loop), and
- the invariant index base (the sum of all terms except the loop
  induction, e.g. `wd_off + j` for the inner `si2` loop, `wd_off + u_len + 1`
  for the `mi` loop) into a callee-saved (or caller-saved for call-free
  inner loops, `x12-x15`) register, so each inner access becomes a single
  `add x1, baseReg, indReg` plus the cached `ldr/str`.

Correctness was verified (asm: the inner multiply loops no longer reload
`remainder.digits.data` per iteration, and the `wd_off + j + si2` index
computes as `base + si2`; all tests pass), but A/B benchmarking showed
**no measurable speedup on pidigits (0.686s → 0.684s, <1% on both n=1000
and n=4000, outputs identical) and the extra preheader code adds
register pressure for outer loops that already have a `div128` call
(`callFree=false` for the outer `j` loop, so caller-saved cannot be used
and the x23-x28 pool is still exhausted — the outer `j` loop's data
pointer hoist fails to allocate).** The inner loops do hoist (one data
pointer to `x28`, one base to `x27` etc., verified via `NOMEN_PIPE_DBG`),
but the saved loads are L1 hits fully overlapped with the `mul`/`umulh`
/ `subs` work, so they were never on the critical path — the same
reason the earlier `loop_buffer_licm` (data-pointer-only) was reverted
(bench/IMPROVEMENTS.md:589). The per-loop overhead (cache-map copy,
body scan, extra callee-saved saves) offsets the saving.

The implementation is kept disabled (default OFF) as the seam a future
more comprehensive address-materialization pass would drive. The honest
remaining lever for pidigits is the per-statement `x0` staging model
itself: the `wd_off + j + si2` index sum and the store's value/index
ordering still sequence through `x0`/`x1`/`x2` with slot spills; collapsing
that needs a fuller value-numbering / register-coalescing pass, one order
larger than this tranche. That, plus nbody's field-pair SLP (D step 2),
are the structural blockers for the 1.5× criterion.

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
