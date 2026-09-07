# ASM_PLAN_5.md — the NIR-allocator project: per-region reassignment + receiver materialization

> Follow-up to ASM_PLAN_4.md (fully discharged for item 1; item 2's asm-level
> slices landed as tranches 1–2 of this project). Constraint unchanged:
> **the aarch64 artifact stays hand-written assembly — no clang/LLVM in the
> aarch64 build.**

## Where this fits

ASM_PLAN_4 item 3's accounting named the structural blockers for pidigits'
last multiple: receiver-PATH re-derivations, cross-statement live ranges for
temporaries, and per-region reassignment of the callee-saved pool — "attack
it in the NIR allocator (stages 1–3 substrate), NOT the loads." This plan is
that project, decomposed.

## Fresh receipts at HEAD (2026-09-06, post tranches 1–2)

Interleaved medians: pidigits n=4000 0.55 s vs C `-O2` 0.35 s (**1.57×**);
fannkuch 2.12 s (−28% this session). Sample profile moved: mul_to's `end_28`
subtree (447 samples) co-dominant with div_to's Knuth-D (437), and the **D2
q_hat shift loops (`.end_while_17`, 302)** newly hot — branchy bodies the
asm-level tranches refuse (label-free requirement).

Census of the D4-multiply loop at 25 instructions: 2 derivation (receiver
path re-run per iteration), ~4 dead/staging movs, a 6-instruction index
chain, 4 essential compute, 4 carry (tranche 2 minimal), 1 load, 2 store.

## The structural insight

`get_buffer_data_ptr` ALREADY implements receiver materialization — a
function-wide `buffer_data_cache` keyed by receiver path, claiming pool
registers. In div_to it never engages: `alloc_buffer_cache_reg` excludes
`callee_saved_regs_used` (the allocator's function-wide claims) and the pool
is exhausted — the derivation falls back to uncached x9, re-run per
iteration (tranche 1's memo only deduplicates WITHIN a region). **Per-region
reassignment is the enabler**: a register whose function-wide occupants are
dead throughout a loop is free INSIDE the loop; the existing cache then
materializes the receiver once per loop.

## Tranche 1 (this document) — region-scoped pool claims + loop-pinned receiver materialization

Landed 2026-09-06 as `src/build_aarch64/region_pool.ts` +
region computation in `nir_regalloc.ts` + the while-dispatch bracket in
`emit_nir.ts` + the pre-seed application in `build_while_loop_node`.
Kill-switch `set_region_pool_enabled` — **DEFAULT ON** (soundness
RESOLVED 2026-09-07, see below).

- **Plan side**: `analyze_ranges` also computes per-name CFG block
  membership (live_in/live_out/defs). After the function-wide assignment,
  for each natural loop: pool registers whose every occupant's block
  membership is disjoint from the loop's blocks are REGION-FREE, with the
  occupants recorded as displaced (source names via the site table;
  site-keyed and untyped occupants refuse the register). The loop's
  Buffer-accessor receiver paths (plain name or one field hop) are
  collected with an invariance gate: the receiver root is only written by
  statements that ARE that receiver's own pinned accessors (may-def
  marshalling), and every real call (non-call-free-refined) refuses the
  loop.
- **Emit side**: the while-dispatch bracket borrows the first region-free
  register per receiver (never shared — two receivers on one register
  alias their data pointers, the spectral-norm receipt): spills the
  displaced occupants to their frame slots (pre-allocating slots via the
  tranche-D-addendum machinery when the declares live later in the body),
  derives each receiver's data pointer into its pin BEFORE the loop
  header, pre-seeds `buffer_data_cache` (applied by the loop builder after
  its snapshot-clear, so in-loop accesses hit the pre-materialized
  pointer), and at exit restores the displaced occupants. The pin rides
  `callee_saved_regs_used` for the whole bracket, so every other claimant
  (loop promotion, staging pins, tree pools, inline expansions) refuses it.
- **Function coverage**: methods plan through `seed_function_allocations`
  (BigInt's Knuth-D loops live there); top-level functions through
  `build_function_node`'s plan branch — both publish `nir_region_free`.
  Functions without promotable candidates still get region entries (the
  assignment walk is gated, not skipped).

### RESULT — measured with the switch FORCED ON (interleaved best-of-7,

outputs byte-identical across backends on every bench): pidigits n=4000
0.55 → **0.53 s** (cumulative −16% vs the 0.64 baseline; ~1.51× vs C `-O2`),
fannkuch-redux 2.12 s (−28% cumulative, unchanged), bench matrix neutral.
Census: the D2 shift loops' receiver derivations + `mov` copies hoisted
entirely (stores read the pin: `str x0, [x28, x25, lsl #3]`), displaced
occupants round-trip through pre-allocated slots. Full suite green
(default OFF), with `test/region_pool.test.ts` (hoist shape, foreign-write
refusal, kill-switch, behavioral both backends) and the byte-identity
harness holding the pass off in both arms.

### Tranche 2 (2026-09-07): the vn_param_inits merge — the D4 index chains land

The forced-ON verification exposed the reason the D4 loops' store-index
chains still rebuilt raw despite the VN hoists firing: **each loop's
`vn_param_inits` map overwrote the accumulated function-wide map**
(`walk.vn_param_inits = vn_param_map` — an assignment). div_to's later
loops (D4-multiply/D4-subtract) silently lost every earlier loop's
`_param → _vn` rewrites at emission, so their accessor index staging
rebuilt the full `wd_off + u_len + 1 + mi` chains per iteration while the
preheader's `_vn` compute sat dead. Fix: merge the per-hoist map into
`walk.vn_param_inits` (keys are per-statement AST nodes — no collisions).

Result: the D4-multiply store index emitted as
`ldr x10, [_vn]; mov x3, x28; add x10, x10, x28` (the hoisted invariant +
the induction — 3 instructions instead of 5, and the dead preheader
compute now pays). pidigits n=4000: 0.55 → **0.53 s** on top of the
tranche-1 state.

### Soundness — RESOLVED, DEFAULT ON (2026-09-07)

The forensics sessions closed four holes (full list in FOLLOWUP.md
"Region-pool receiver pins — RESOLVED"): the pin-register ABI (pins ride
`plan.callee_saved` — an unsaved callee-saved pin destroyed the CALLER's
live value: first_child clobbered measure_w's x25), shared-register
refusal (N sharers, N values, one reload point), emit-time binding
refusal (loop promotion's claims install into `register_allocations`
at scope-open, invisible to the plan-time map — the inner c-loop's
induction was promoted into the pin register and destroyed), and the
first-landing attribution/ordering fixes. The last one (edigits'
`0 :1`) was the emit-time-binding case. Full bench matrix
byte-identical, suite green default-ON. The pass remains
non-cursor-dependent in the harness sense (emission-driven, runs in
both arms of the byte-identity tests).

## Next tranches

1. **Soundness hunt** (gates the default): shrink the layout/lru corruption
   to a minimal repro; the suspect list is in FOLLOWUP.md.
2. **Region-scoped source variables**: loop-contained hot locals (the D2
   spill slots) assigned from the region-free registers by the planner
   itself, with the same bracket bookkeeping.
3. **Index-chain strength reduction at the NIR level**: the D4-multiply
   store index (`wd_off + u_len + 1 + mi`) rebuilds per iteration because
   VN's channels don't cover accessor-argument positions (the L forwarding
   removes the `_param_N` host VN's alloc channel needs).
4. **mul_to coverage**: its plan produces no region entries (early return
   or receiver shapes) — extend the receiver collection to its accessor
   forms.
