# ASM TODO — outstanding work from the ASM_PLAN_* / PERF docs

The discharged plans were moved to `docs/scratch/`. Two plans still carry
open items and stay in place: `ASM_PLAN_4.md` and `ASM_PLAN_7.md`. What
remains to be done from each:

## ASM_PLAN_4.md — remaining steps

- **Shifted-index vectorization (`load(i + 1)`) — BLOCKED UPSTREAM.** The
  soundness design exists (per-element event-order rule), but the checker's
  bound verifier cannot prove `i >= 0 && i + 1 < cap` under any guard shape.
  No shifted program reaches the NEON planner today; unblocking means
  extending the verifier (memory-safety-critical).
- **Byte (`.16b`) element kinds.** `load_T`/`store_T` are not in the scalar
  inline fast path (they emit real calls), so there is nothing to vectorize —
  needs scalar-path inlining first. Byte loads also hit the same checker
  bound-verifier gap as shifted indices.
- (The rest of ASM_PLAN_4 is closed: item 1 SLP landed; item 2's
  allocator-level pass was carried out by ASM_PLAN_5/6; item 3 accounting
  written; item 4's other bullets are decided/superseded; item 5 done.)

## ASM_PLAN_7.md — remaining aarch64 gap

All eight tranches landed, but the plan's target is not fully met:

- **Cause 6 — real calls + ABI marshaling (the main residual).** Auto-inline
  of small methods (tranche 7) shipped **leaf-only**; call-bearing splices
  (`ensure`/`grow`) measured +52–62% regression and are gated off. Unlocking
  them needs a properly nested frame context plus an inline cost model. (The
  doc cites FOLLOWUP.md, but that entry was never written — add it there.)
- **pidigits still ~1.5× vs C `-O2`** (spectral-norm closed by tranche 8).
  Causes 2–5 and 7 are addressed; cause 6 is the remaining named lever.
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
  scratch/induction hoists (ASM_PLAN_5/6/7) now cover this; the only
  leftover is the dead `buffer_pipeline.ts` below.
- **Doc refresh.** PERF.md's narrative sections are stale: the "aarch64
  release passes are perf-neutral" table and the SIMD-gap framing predate the
  ASM_PLAN_2–7 arc (NEON landed, spectral-norm closed, etc.), and the
  "Rejected" loop-unrolling row is outdated (implemented, default-off).
  Settled rows: NEON row is landed; the `str/ldr` and `Buffer.data` LICM
  rejections stand.

## Related dead code (from FOLLOWUP.md)

- **`src/build_aarch64/buffer_pipeline.ts` never runs.** `set_buffer_pipeline_enabled(true)`
  is never called, so `tryHoistBufferAddrs` always returns at the enable
  check. Its receiver data-pointer hoisting is now done by the region
  brackets (`region_pool.ts`) + emit-time fallback. Either delete the file
  and its `BuildStatus` fields, or wire the enable switch — before it
  misleads another tranche.

## Parked / measured-not-shipped (already recorded in FOLLOWUP.md)

- ASM_PLAN_5 tranche-3 shelved pieces: x15 reservation, nested-loop pin
  refusal, `collect_var_refs` coverage, promotion site-sharing.
- ASM_PLAN_6 tranche 3 base-fold: completed by tranche 6 (not open).
