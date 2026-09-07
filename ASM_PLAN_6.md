# ASM_PLAN_6.md — D4 scratch registers: modeling the call-free loop's dead registers

> Follow-up to ASM_PLAN_5.md (fully discharged: items 1–4 landed or refused
> with receipts). Constraint unchanged: **the aarch64 artifact stays
> hand-written assembly — no clang/LLVM in the aarch64 build.**

## Where this fits

pidigits' remaining gap to C `-O2` (~1.57×) lives in div_to's Knuth-D
core — above all the **D4-multiply / D4-subtract loops** (mi/si2), which
every allocator tranche since ASM_PLAN_5 tranche 1 has refused. The plan
census of the D4-multiply loop at 25 instructions: 2 derivation, ~4
dead/staging movs, a 6-instruction index chain, 4 essential compute, 4
carry, 1 load, 2 store.

## The wall every mechanism hit

Pool exhaustiveness is the blocker, and it is REAL at the granularity
every mechanism models: the D4 loops' live values (n, j, wd_off, q_hat,
u_len, shift, …) plus the loop's own function-wide temps (mi, vv,
lo_prod, hi_prod, prod — interference-shared across x12–x15) span all
10 pool registers. Region pins, region vars, loop promotion, and the
buffer pipeline all draw from that same pool (+ ext) and all refuse.
Tranche 4 proved no dom/reach refinement can declare any of them dead.
Tranche 6 made the `_vn` bases promotion-eligible; they still had
nowhere to go.

## The structural insight

The pool model is TOO COARSE for call-free loops. A call-free loop body
cannot marshal calls, so most of the caller-saved register file is dead
by construction — but the allocator only models x12–x15 as borrowable
ext. The D4-multiply loop's own asm uses: x0 (tree eval), x2/x3/x10/x11
(staging/tree temps), x9 (derivation scratch), x12–x15 (values),
x16/x17 (carry/flag forms — **already loop-carried in shipped code**),
x19–x28 (params/stable values). **x4–x8 appear nowhere.** The raw
accessor bodies in these loops (Buffer load_int/store_int, BigInt
get/set/get_at/set_at, mul_wide_hi) confine themselves to x0–x3. If a
sound scan says a loop's emission can never touch x4–x8, they are
genuinely free for the whole bracket — zero prologue cost, no ABI role.

One stable scratch register per loop unlocks, in increasing value:

1. **Receiver pins for the D4 loops** — the per-iteration derivation
   (`add x9, x22, #24; ldr x9, [x9, #8]`, 2 instrs × 4+ loops) hoists
   exactly like the region pins ASM_PLAN_5 shipped for the D1/D2/D6
   loops, into a scratch register instead of a pool register.
2. **Base-folded addressing** — with the data pointer stable, fold the
   invariant index base INTO it: `x_ptr' = data_ptr + base*8` computed
   once; the store `str x12, [x_ptr', x28, lsl #3]` then uses the bare
   induction register. Kills the `_vn` base slot load (`ldr x10,
   [x29, #base]`) and the index `add` per access — the "fewer live
   ranges" ASM_PLAN_5 item 3 wanted, without a new variable.
3. **Region vars / `_vn` bases** — any remaining scratch register hosts
   the loop-contained locals tranche 5 found no room for.

## Tranches

1. **Scratch-set survey + planner offers** (this document's first
   landing): enumerate the register touch-sets of every emission path a
   call-free loop body can exercise (tree evaluator, staging, raw
   accessor families, flag/cset/carry forms, buffer pipeline) and derive
   the sound scratch set. The planner then offers scratch registers to
   call-free loops whose standard pools are exhausted (region entries
   with scratch pins); the bracket borrows them with the usual
   spill/restore bookkeeping (nothing to spill — unoccupied by model).
   Kill-switch shared with `region_pool_enabled`.
2. **D4 receiver pins fire** — verify the 4 hot loops (mi, si2,
   try_count, cmp_i) take scratch pins, derivations hoist, bench matrix
   byte-identical, pidigits timing.
3. **Base-fold**: pin derivation becomes `data_ptr + base*8` for loops
   whose accessor index args are VN-split (`_vn + induction`); the
   accessor staging substitutes the bare induction. Kills the per-access
   base load + add.
4. **Sweep**: region vars / `_vn` bases onto remaining scratch regs in
   other call-free hot loops (try_count/cmp_i chains, D2 subtree);
   measure and keep only what pays.

## Verification discipline (unchanged)

Kill-switch A/B (byte-identical when off), the full suite green
default-ON, the bench matrix byte-identical across backends (pidigits,
edigits, fannkuch, lru, spectral-norm, binarytrees, mandelbrot,
nsieve, nbody, merkletrees), and interleaved best-of timing on
pidigits n=4000 + fannkuch.
