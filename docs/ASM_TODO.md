# ASM TODO — outstanding aarch64 performance work

The ASM_PLAN arc is **closed**: `ASM_PLAN.md` through `ASM_PLAN_7.md` are all
discharged and live in `docs/scratch/`. PLAN_4's remaining items (shifted
reads, byte kinds, the checker discharges) and PLAN_7's tranches 1–8 (incl.
the tranche-7 auto-inline unlock and the frame-slot store-store kill) all
landed; PLAN_7's pidigits target is met-or-structurally-accounted
(~1.5× vs C `-O2`, with the residual decomposition written up in
`ASM_PLAN_7.md` addendum 5). What follows is the genuinely open work.

## aarch64 codegen

- **pidigits +1.2% net regression from the call-bearing auto-inline**
  (measured 2026-10-04, pre-session `7b36feac` vs HEAD, 10 interleaved
  pairs, distributions cleanly separated). The spliced `ensure`→`grow_int`
  chains grow the hot functions' text (~+96 lines in mul_to alone) at an
  I-cache/layout cost; the store-store kill clawed back ~0.7% of it. The
  candidate fix is a splice **cost model**: skip expansion when the callee's
  text growth lands in a function whose hot loops would be displaced
  (a size-vs-call-frequency heuristic). Small tranche, clear receipt
  (pidigits back to ~500 ms, lru keeps its win).
- **NEON variable-shift reads — planner support.** The checker now
  discharges `load_int(j + d)` against `while j < n - d` (variable-shift
  discharge, 2026-10-03), but the NEON planner's `shifted_index_of` still
  requires a LITERAL `c >= 1` (the adjusted-pointer materialization and the
  trip-limit `sub` are compile-time-constant forms). Planner support needs
  a register-held shift: `add xK, buf, d_reg` for the adjusted pointer and
  `sub`/`asr` with a register operand for the trip limit — both encodable;
  the soundness model (per-element event-order, c >= 0 at runtime — note
  a NEGATIVE runtime d with a literal-shaped discharge would break the
  event-order rule, so the discharge must also prove `d >= 0`, which
  `range_lower >= 0` already covers) carries over.
- **mul_to's residual** (the pidigits hot loop): accessor staging movs that
  are LIVE (register-pressure artifacts — `mov x13, x0` holds the lo product
  across the `umulh` clobber) and the result-tracking diamond
  (`if result != 0 { last_nonzero = i + 1 }` — 6 instructions the
  if-conversion pass cannot merge: the arms are empty-vs-computed, not
  one-operand-different). Both need allocator-level insight (live ranges
  for the staging temporaries), not text passes.

## Runtime / library

- **Faster allocator** — per-node `malloc`/`free` churn dominates
  binarytrees/merkletrees (allocation-dominated benches); a slab/bump path
  for class allocation is the largest unclaimed perf lever (an `Arena<T>`
  container exists in the library but the class-allocation path isn't on
  it).
- **Tighter `bl` cache invalidation (per-receiver)** — any non-inlined call
  drops every field data-pointer cache entry
  (`build_function_call_node.ts:1221` deletes all `"."` keys);
  per-receiver invalidation would re-enable within-loop cache hits across
  calls. **Scoped 2026-10-04 — paused, may be affected by planned ownership
  work.** The shape: replace the blanket drop with a ROOT-SET drop — a call
  invalidates entries whose root segment is the receiver's root or the root
  of a `ref`/`var`/`move` argument (by-value struct args can't reach the
  caller's buffers; extern calls stay fully opaque). The core change is
  small (~30–50 lines in the two call builders); the risk is the soundness
  surface: (1) the ownership/borrow rules must guarantee a cached
  one-level-field entry can't alias a surviving entry's slab (ref-param
  record-transfer machinery is a good sign); (2) module-level `var buf`
  keys as a bare name — under the CURRENT rule such entries wrongly survive
  calls (a potential live stale-pointer bug independent of this change —
  investigate first); (3) `func`-typed params can invoke escaped closures
  (`address_escaped` flag reusable). Receipt-gated: the win needs a bench
  with hot field-buffer access loops containing calls to unrelated
  receivers — none of the current benches has that shape (lru is Map-based,
  knucleotide is raw asm), so step 0 is building one; without it this lands
  as neutral infrastructure. Revisit after the planned ownership changes
  settle.
- **d0–d7 float params** — params still arrive as raw bits in x-registers;
  only the `fcmp` + d0-return halves of the convention landed. Deferred
  because the measured win on the suite is ~0 and `function_param_regs`
  has a broad blast radius — do it only with a receipt.

## Parked / closed-unless (already recorded in FOLLOWUP.md / ASM_PLAN_7)

- **Function-scoped write-only-slot elimination** — closed: "never-loaded"
  slots have invisible consumers (extern adapters and helper frame
  conventions read caller frames at fixed low offsets — the
  `Console_write` parks receipt, ASM_PLAN_7 addendum 5). Reopen only with
  a convention registry.
- **ASM_PLAN_5 tranche-3 shelved pieces**: x15 reservation, nested-loop pin
  refusal, `collect_var_refs` coverage, promotion site-sharing.
- **PERF.md** is current as of 2026-10-03 (rewritten for the post-arc
  reality; the release-vs-debug table re-measured).
