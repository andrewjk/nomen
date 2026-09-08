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

### Tranche 4 (2026-09-08): mi-loop staging movs — dead-move elimination inside validated cycles — LANDED

The mi loop's remaining census fat was the staging movs: the per-statement
emission stages every operand into a fixed protocol register (`mov x2, x23`
before a compare, `mov x1, x27` before a multiply) even when the consumer
reads the SOURCE register directly. The copy coalescer substitutes read
operands and deletes only the moves it FLAGGED — a move whose consumer never
read the destination in the first place is never flagged, and the
function-wide dead-move pass ships default-OFF (the nbody measured-loss).
Inside the hot loop the leftovers execute per iteration: the D4-multiply
cycle alone carried five (`mov x2, x23`, `mov x1, x27`, `mov x0, x19`,
`mov x2, x12`, `mov x11, x9`).

New pass `src/build_aarch64/asm_cycle_dead_moves.ts`, wired into build.ts
AFTER coalesce_copies: a `mov xD, xS` whose destination is provably dead is
deleted — but ONLY inside validated cycles (the promote_loop_slots model:
header label … unconditional back-edge, header provenance from inside, no
bl/blr/br/svc/ret; fall-through marker labels like `.while_update_N:` ride
inside, a label any jump targets blocks the cycle). The liveness is EXACT,
not the two-set taint approximation: a function-level CFG (blocks at labels
and b/b.cond/cbz/cbnz/tbz/tbnz/ret; fall-through + resolved-target edges,
numeric `1f`/`1b` forms included; `br` or an unresolvable target aborts the
pass) with a backward fixpoint. The exactness is the point: the si2 base's
`mov x14, x0` escapes through the loop exit and KEPTS its move, while the
guard's compare staging — whose exit path redefines x2 before any read —
dies. `bl`/`blr` read x0–x8/d0–d7 and define the caller-saved set, so a
staging mov feeding a downstream call argument survives (the `.while_25`
`mov x3, x28` receipt). Deletions iterate to a fixpoint (a deleted move's
source read can kill a chained move). Kill-switch
`set_cycle_dead_moves_enabled` — default ON.

Two soundness receipts caught landing it:

1. **The w-sibling read** (buffer_uint32_split, suite-caught): the store's
   value staging `mov x2, x0` fed `str w2, [x23, x24, lsl #2]` — the CONSUMER
   reads the W-SIBLING of the def, and the exact-name liveness model saw x2
   dead. Every iteration stored garbage. Fix: a candidate mov's dest is only
   dead when NEITHER xD NOR wD is live.
2. **Interior jump-target labels**: the first cut refused ANY interior label,
   which refused every `.while_update_N:`-shaped cycle (the emitter's
   fall-through marker). The rule is now: interior labels with no jump
   predecessors ride inside; a label any jump targets breaks the cycle.

Result: 26 deletions across div_to's cycles; the D4-multiply loop drops from
25 to 20 instructions/iteration (2 derivation, 4 live staging, 6-instruction
index chain — now the base load + 2 adds — and the essential compute + carry
remain). Bench matrix byte-identical across backends (pidigits, edigits,
fannkuch, lru, spectral-norm, binarytrees, mandelbrot, nsieve, nbody,
merkletrees, knucleotide); full suite green default-ON (291 files / 2836
tests) with `test/asm_cycle_dead_moves.test.ts` (mi shape, exit-escape keep,
chained fixpoint, w-sibling keep, call refusal, numeric labels, kill-switch,
behavioral both backends). pidigits n=4000 interleaved best-of-7:
0.52 → **0.50 s** (cumulative 0.64 → 0.50 across the arc; ~1.43× vs C
`-O2`); fannkuch-redux 2.12 → **2.03 s** (−4%, the same staging leftovers
pruned in its hot loops).

### Tranche 5 (2026-09-08): scratch-set modeling at the NIR allocator level — LANDED

The revisited tranche-1 idea (deferred when the survey pivoted to asm-level
slot promotion): the pool model is too coarse for call-free loops. A
call-free loop cannot marshal calls (args ride x0–x7, sret x8 — all
call-side), the allocator's pools are x12–x15/x23–x28, loop promotion takes
x16/x17, staging and tree eval stay in x0–x3/x9–x11, and the raw accessor
bodies confine themselves to x0–x3 — **x4–x8 appear nowhere**. The planner
now models them: a call-free loop whose pools are EXHAUSTED (every pool
register holds a genuinely live occupant — the tranche-4 ceiling) earns
SCRATCH PINS in `NIR_SCRATCH_X = [x8, x7, x6, x5, x4]` (x8 first), riding
the existing region-bracket machinery with a dedicated scan.

Plan side (`utils/nir_regalloc.ts`): the scratch branch fires only when
`free_regs` is empty and receivers were collected; the eligibility scan
walks the same nesting-complete region the receiver collection uses and
refuses the loop on the first unsafe shape — raw blocks, func/spawn (dead
under the call gate, kept as defense), break/continue/return (invisible
cleanup and exit-path emission the scan cannot see), for (iterator
materialization; the for-of element-copy arm reads x8), panic/todo/let/
async_block — and every inline accessor call must resolve to a raw-only
method whose comment-stripped aarch64 text never mentions x4–x8, with ≤4
params (call-site staging reaches x4+). Owning-element/string-element
Buffers and Array_string accessors refuse outright (their specializations
emit x4/x20-pair sequences over the raw bodies). Nested scratch candidates
defer: an outer candidate whose region strictly contains another candidate's
yields the register to the inner (hotter) loop — the inner builder
snapshot-clears the pre-seeded cache, so an outer pin would buy it nothing.
Kill-switch shared with `region_pool_enabled`.

Emit side (`region_pool.ts`): scratch pins take NEITHER claim set — no
`callee_saved_regs_used` (no prologue save: no pool ever assigns x4–x8, and
the pin is dead after the bracket), no `nir_caller_saved_claimed`;
`region_pinned` remains the only guard (nested brackets and promotion's
sharing path must not touch the register while a pin is open). Nothing to
spill, no exit restore.

Two receipts caught landing it:

1. **The sibling-fold refusal (mi/si2 got no entries at all).**
   `region_loop_blocks`' exit-less-nest closure folded every dominated loop
   whose header REACHES this header — but any later sibling inside the same
   enclosing loop reaches it through the enclosing back-edge, so si2/D5 and
   the `ensure` tail folded into the mi loop's region and a real call
   inside a folded sibling refused the mi entry although the bracket never
   executes those blocks. Fix: region = natural loop ∪ break-path closure
   ∪ dominated exit-less nests (below).
2. **The break-path closure (the lru receipt, correctly characterized).**
   The shipped closure was over-conservative (it folded post-loop siblings
   too); the naive tightening (natural loop + exit-less nests only)
   segfaulted lru immediately: the sh-loop sits on the find-loop's BREAK
   path — blocks that escape the body without reaching the latch, yet
   execute INSIDE the bracket. The correct set: analyzed body ∪ backward
   closure from the exits (stopping at the header, header-dominated blocks
   only) ∪ dominated exit-less nests. The exit blocks themselves stay OUT
   (they hold post-loop statements — real calls, x4–x8 use; names
   boundary-live there are already refused transitively via live-out
   membership of their body preds). The closure change ALSO un-blocked a
   pool pin for the mi loop (its region shrank past si2/D5's genuinely-live
   occupants), so the D4-multiply loop now pins through the ordinary pool
   path.

Result: div_to carries 9 region brackets (D1-si ×2, D3 pi/try_count, cmp_i,
D4-mi, D4-si2, D5-ai, add_carry) plus the asm-level tranches; the D4-multiply
loop reads its receiver through pin x15 at **15 instructions/iteration** (25
at the arc's start), and the D4-subtract loop takes the SCRATCH pin x8 with
both accesses base-folded through x17. Bench matrix byte-identical across
backends (pidigits, edigits, fannkuch, lru, spectral-norm, binarytrees,
mandelbrot, nsieve, nbody, merkletrees, knucleotide); full suite green
default-ON (292 files / 2841 tests) with `test/scratch_pool.test.ts`
(exhausted-shape pin, raw-body-touch refusal, kill-switch, behavioral both
backends, break-path behavioral). pidigits n=4000 interleaved best-of-7:
neutral within noise (medians 0.52 → 0.51 vs HEAD; the D4 pins remove
2 instructions/iteration while the widened bracket set adds preheader
work elsewhere). The tranche's deliverable is the mechanism: the allocator
now models x4–x8, which is the precondition tranche 3 (base-folded
addressing) deferred for.

## State

Tranches 1–2 landed and tranche 4 landed (default ON, suite green, matrix
byte-identical, pidigits 0.64 → **0.50** across the ASM_PLAN_5+6 arc;
tranche 3 deferred below the noise floor). Tranche 5 landed the scratch-set
model (x4–x8) at the NIR allocator level with the corrected region
characterization. The D4 census closes: of the original 25
instructions/iteration, the derivation (2), the base slot load (1), the
carry slot round-trips (si2) and the five dead staging movs are gone; what
remains is essential compute, the accessor marshaling the raw bodies
genuinely need, and the flag-form carry.
