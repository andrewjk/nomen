# ASM TODO — outstanding work from the ASM_PLAN_* / PERF docs

The discharged plans were moved to `docs/scratch/`. Two plans still carry
open items and stay in place: `ASM_PLAN_4.md` and `ASM_PLAN_7.md`. What
remains to be done from each:

## ASM_PLAN_4.md — remaining steps

- **Shifted-index vectorization (`load(i + 1)`) — LANDED 2026-10-03.** The
  checker's bound verifier accepts the shifted guard shapes (the ASM_PLAN_4-era
  verifier gap is gone); the remaining blocker was in the NEON planner, and
  the per-element event-order rule landed: `load_T(i + c)` with a literal
  c >= 1 plans through an adjusted read pointer, stores stay exact-induction,
  the trip limit shrinks by the max shift, c <= 0 refuses. Differential
  on/off + oracle receipt in `test/neon_vector.test.ts`.
- **Byte (`.16b`) element kinds — LANDED 2026-10-03.** `Buffer<uint8>` loops
  ride the new `load_u8`/`store_u8` width-matched raw inlines (the scalar
  path is the naked-inline splice, same as load_int) and a `.16b` descriptor
  (16 lanes per group); reductions and `*` stay unplanned for e1.
- **Shifted-read checker discharge — the ref-param/path gap FIXED 2026-10-03.**
  A helper taking `ref Buffer` args can now prove `load(i + 1)` against
  `while i < a.cap - 1` + `if b.cap >= a.cap`: `expr_to_string` renders
  `path ± int` bounds (the loop fact now records), `apply_bounds` mirrors
  path-vs-path guards onto the other side's path entry (`a.cap <= b.cap`),
  and the transitive chain relaxes tighter intermediates and consults
  `path_bounds` for dotted hops.
- **VARIABLE-shift discharge — LANDED 2026-10-03.** `load_int(j + d)`
  verifies against `while j < n - d` (+ a `d <= n`-style guard): the arg's
  stored fact cancels token-for-token (`j < n - d` + `d` => `j + d < n`),
  `expr_to_string` renders `path ± var` bounds, numeric ranges do NOT
  transfer (the shift is a runtime value — transferring them understated
  the arg's reach), the arg's provable `>= 0` lower rides the token's own
  `range_lower >= 0`, and `invalidate_token_facts` sweeps every stored
  fact referencing an offset variable on reassignment/shadow/ref-binding.
  The soundness receipts: shadow-before-use and pre-use mutation refuse;
  post-use mutation composes (the condition re-establishes per
  iteration). `test/flow_bounds.test.ts` pins all four shapes.
- (The rest of ASM_PLAN_4 is closed: item 1 SLP landed; item 2's
  allocator-level pass was carried out by ASM_PLAN_5/6; item 3 accounting
  written; item 4's other bullets are decided/superseded; item 5 done.)

## ASM_PLAN_7.md — remaining aarch64 gap

All eight tranches landed, and the tranche-7 follow-up landed 2026-10-03:
call-bearing auto-inline is UNLOCKED (the +52–62% receipt was two
`build_inline_method` state leaks — `nir_site_allocs` never restored, and
`int_dest_hint`/`float_dest_hint` leaking into spliced bodies; see the
follow-up section at the end of ASM_PLAN_7.md). The ensure→grow_int chain
splices with zero hot-path bls.

- **pidigits ~1.5× vs C `-O2`** (spectral-norm closed by tranche 8). The
  store-store kill (optimize_frame_slots) took ~1-2.4% back (the carry-flag
  slot residue in mul_to's hottest loop); the write-only-slot class beyond
  the block boundary has INVISIBLE CONSUMERS (extern adapters and helper
  frame conventions read caller frames at fixed low offsets — deleting
  `Console_write`'s never-loaded parks corrupts the output; see the
  ASM_PLAN_7 addendum 5 receipts) and is closed unless a convention
  registry lands. The residual decomposes into accessor staging movs that
  are LIVE (register-pressure artifacts) and the if-converted diamond the
  planner cannot merge.
- **Tranche list re-check:** tranches 1–8 all landed (tranche 1 =
  `asm_if_convert.ts` / `test/if_convert.test.ts`; the doc has no write-up
  for it).

## PERF.md — "Not implemented (future work)"

- **d0–d7 float params.** Params still arrive as raw bits in x-registers;
  only the `fcmp` + d0-return halves of the convention landed. Deferred
  because the measured win on the suite is ~0 and `function_param_regs` has
  a broad blast radius — do it only with a receipt.
- **Tighter `bl` cache invalidation (per-receiver).** Any non-inlined call
  currently drops every field data-pointer cache entry
  (`build_function_call_node.ts:889` deletes all `"."` keys); per-receiver
  invalidation would re-enable within-loop cache hits across calls.
- **Faster allocator.** Per-node `malloc`/`free` churn dominates
  binarytrees/merkletrees; no slab/bump path in the runtime (an `Arena<T>`
  container exists in the library but the class-allocation path isn't on it).
- **General LICM of loop-invariant array bases/bounds — effectively
  SUPERSEDED.** The NIR CFG/dominance substrate + region brackets and
  scratch/induction hoists (ASM_PLAN_5/6/7) now cover this.
- **Doc refresh.** PERF.md's narrative sections are stale: the "aarch64
  release passes are perf-neutral" table and the SIMD-gap framing predate the
  ASM_PLAN_2–7 arc (NEON landed, spectral-norm closed, etc.), and the
  "Rejected" loop-unrolling row is outdated (implemented, default-off).
  Settled rows: NEON row is landed; the `str/ldr` and `Buffer.data` LICM
  rejections stand.

## Parked / measured-not-shipped (already recorded in FOLLOWUP.md)

- ASM_PLAN_5 tranche-3 shelved pieces: x15 reservation, nested-loop pin
  refusal, `collect_var_refs` coverage, promotion site-sharing.
- ASM_PLAN_6 tranche 3 base-fold: completed by tranche 6 (not open).
