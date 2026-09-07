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
   induction register. Kills the `_vn` base slot load
   (`ldr x10, [x29, #base]`) and the index `add` per access — the "fewer
   live ranges" ASM_PLAN_5 item 3 wanted, without a new variable.
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

### Tranche 1 (2026-09-07): read-only slot promotion — LANDED (pivoted)

The survey found the scratch-pool question already answered by shipped
code: ASM_PLAN_4 tranche 2's `asm_loop_promote.ts` renames loop-carried
slot round-trips into x16/x17 on lifted assembly — but only for slots
WRITTEN in the cycle (the carry shape). The D4 `_vn` index bases are
READ-ONLY in their cycles, so the extension is small: read-only
candidates (`reads` ∧ ¬`writes` ∧ ¬dirty) take the promotion registers
LEFT OVER after the write-slot carries (write-first priority), get the
entry load, and get **no exit sync** — the cycle never writes the slot,
so memory stays authoritative for everything outside. The one staleness
hazard (an enclosing cycle promoting the same slot as a write-carry and
updating only its register) is closed by the existing overlap guard: a
cycle containing an already-promoted inner one is skipped entirely.

Result in div_to: the try_count base (x16), the cmp_i loop's TWO bases
(x16+x17), the D4-multiply base (x17), the D4-subtract prod base (x17),
and the D5 base (x16) all hoist — the coalescer folds the renames into
`add x10, x17, x28`, the exact clang shape; per-iteration the base's
`ldr` disappears from each access. pidigits n=4000: 0.55-0.58 →
**0.54-0.56** (median 0.54); fannkuch 0.17 unchanged; bench matrix
byte-identical across backends; full suite green default-ON (290 files
/ 2823 tests) with the read-only promotion shape + write-priority + the
re-scoped no-exits test in test/loop_promote.test.ts.

Remaining in this plan: tranche 2's register-starved leftovers (the
si2 loop's second base `wd_off + j` went unpromoted — two read-only
slots, one free register after sub_borrow took x16), then base-folded
addressing.

### Tranche 2 (2026-09-08): derivation hoist — LANDED

The asm-level `promote_loop_slots` gained a third candidate kind: the
Buffer receiver derivation. In the emitted text it is a THREE-line
sequence (`mov x9, x22 / add x9, x9, #24 / ldr x9, [x9, #8]`) — or the
two-line form without the base copy — and a loop body may hold SEVERAL
occurrences (one per accessor access). Detection: local shape + a use-
before-sequence dominance gate; then identical sequences group by
(xD, xB, imm, imm2), and a group hoists when its members are the
cycle's ONLY definitions of xD, xB is unwritten outside them, and no
address escape (`add xK, xB, #imm`) or direct field store exists
outside them. Priority: write-slot carries > derivations (2-3
instructions/iteration) > read-only bases (1). Entry recomputes the
pair into the promotion register; every xD use renames (whole-word
text substitution); no exit sync (the field is invariant in a
call-free cycle — ensure/grow are calls).

Two soundness receipts caught during landing (both by the suite):

1. **Frame-derived pairs are NOT derivations**: the for-of
   materialisation reads the CURRENT ELEMENT POINTER from a frame slot
   (`add x16, x29, #24 / ldr x16, [x16, #16]`) — the slot advances per
   iteration (written through an `add x2, x29, #24` address escape the
   field-store check missed), and hoisting froze sum_y on the first
   element ('2' vs '6'). Gate: refuse x29/sp-derived pairs outright.
2. **Address escapes of the base struct** now refuse the group (the
   same escape idiom, generalized to any base register).

Result: the si2 loop's derivation hoists (x17 = the pointer for the
whole cycle; −3 instructions/iteration, the second base's slot read
returns since one register cannot serve both). The mi loop's
derivation STILL does not fire: its TWO occurrences plus the carry and
the base demand three registers and x16/x17 are two — the priority
order (carry > derivation > base) resolves it to the tranche-1
allocation. pidigits n=4000 steady **0.54** (5/5), fannkuch 0.17,
bench matrix byte-identical across backends, full suite green
(292 files / 2827 tests) with the hoist shape + refusal + for-of
regression tests in test/loop_promote.test.ts.

The mi loop's remaining fat is the staging movs (x1/x2/x3 copies the
coalescer cannot fold across the accessor staging protocol) — asm-level
dead-move work inside validated cycles, recorded as the next tranche's
candidate.

### Tranche 3 (2026-09-08): base-folded addressing — scoped, DEFERRED

With the derivation hoisted, base-folding (`x_ptr' = ptr + base*8` at
entry, accesses index by the bare induction) would kill 2
instructions/iteration in the si2 loop — the ONLY loop with a spare
pointer register after the carry and derivation claims. The mi loop
(carry + base + derivation wanting three registers) cannot fold; the
D2 j-loop is call-blocked; the small-b loop is division-dominated. A
2-instruction/iteration win in one loop is below the timing noise
floor (pidigits has been 0.54 across five consecutive samples), and
the shape-matching (scaled-add entry with an x9 scratch, in-cycle
index-substitution restricted to the folded base's accesses) is the
most intricate transform yet. Deferred with the receipt; revisit only
with a mechanism that frees another register (e.g. scratch-set
modeling for call-free cycles at the NIR allocator level).

## State

Tranches 1–2 landed (default ON, suite green, matrix byte-identical,
pidigits 0.64 → **0.54** across the ASM_PLAN_5+6 arc). The D4 census
closes: of the original 25 instructions/iteration, the derivation (2),
the base slot load (1) and — in si2 — the carry slot round-trips are
gone; what remains is essential compute, accessor marshaling movs
(fixed-register raw-body ABI), and the flag-form carry.
