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
   → DONE (2026-09-07, RESOLVED DEFAULT ON above; holes 5–6 below found
   and closed landing tranche 2).
2. **Region-scoped source variables**: loop-contained hot locals (the D2
   spill slots) assigned from the region-free registers by the planner
   itself, with the same bracket bookkeeping.
   → LANDED (2026-09-07, tranche 5 below) — mechanism sound and tested;
   pidigits has no profitable surface (every read loop-contained local
   already holds a function-wide register; the residual slot traffic is
   expansion-ABI staging / dead staging stores).
3. **Index-chain strength reduction at the NIR level**: the D4-multiply
   store index (`wd_off + u_len + 1 + mi`) rebuilds per iteration because
   VN's channels don't cover accessor-argument positions (the L forwarding
   removes the `_param_N` host VN's alloc channel needs).
   → LANDED (2026-09-07, tranche 6 below) — the chain-splitting itself was
   already done (the vn_param_inits merge); this tranche completed the
   promotion side. pidigits' D4 loops stay register-blocked (the tranche-4
   ceiling), so the win is mechanism, not measurements.
4. **mul_to coverage**: its plan produces no region entries (early return
   or receiver shapes) — extend the receiver collection to its accessor
   forms.
   → INVESTIGATED, REFUSED (2026-09-07, tranche 7 below): the extension
   would be a regression — get_at/set_at never read their receivers.

### Tranche 2 (2026-09-07): per-region reassignment of shared pool registers

Unlocked the tranche-1 mechanism where it had starved: div_to/mul_to
claim all 6 callee-saved registers function-wide (52 allocs in div_to),
so no 0/1-occupant register was ever free and zero pins fired in pidigits.
Three plan-side changes (`nir_regalloc.ts` + `region_pool.ts`):

- **Shared-register borrowing**: every occupant dead-in-loop borrows
  through the FIRST plain occupant's home slot (single str/ldr
  round-trip). At most one occupant can need the entry value after the
  loop (a second live-across occupant would interfere and could never
  share the register), so the N-slot spill's home-clobbering (the edigits
  receipt's actual corruption) is gone by construction. Site-keyed
  occupants no longer veto — they just can't supply the slot.
- **Dead-set emit check**: the old blanket bound-register refusal nulled
  every occupied pin (function-wide occupants stay bound in the map
  whether or not they are live). The plan now records every occupant key
  per pin; the bracket allows bound names proven dead and still refuses
  emit-time promotion claims (unknown keys — the edigits inner-`c` case).
- **Raw-stable marshalling allowance**: BigInt get/set/get_at/set_at/
  data_ptr on BigInt-typed receivers are indexed access through the
  current data pointer (verified bodies; call-free ⇒ no ensure/grow ⇒ no
  rewire), so their may-defs join the own-roots allowance instead of
  refusing the pin (the D6-unnormalize receipt: `remainder.set(ri, …)`
  had refused its own loop's `remainder.digits` pin).

Result: D1-shift loops (×2, pin x28) + D6-unnormalize loops (×2, pins
x23/x24) hoisted — 4 brackets in pidigits, outputs byte-identical across
backends (pidigits, edigits, fannkuch checked). pidigits n=4000:
0.53 → **0.52 s** (~1.58× vs C `-O2`). Full suite green default-ON
(290 files / 2816 tests).

Two soundness holes found landing it (both segfaults, both caught by the
bench-matrix discipline, both closed same session — full list in
FOLLOWUP.md):

5. **Share-into-pin** (knucleotide count_seq): loop promotion's
   interference-sharing could not see the pin and shared the j-loop
   induction onto the data-pin register (`ldr x0, [x26, x26, lsl #3]`).
   Fix: `status.region_pinned` (bracket-maintained, nesting-disciplined);
   `can_share_claimed_register` refuses pinned regs.
6. **Nesting-incomplete loop bodies** (lru): analyze_loops' latch
   pred-walk missed nested blocks, so the outer find-loop tested its
   inner's induction dead and borrowed its register. Fix:
   `region_loop_blocks` (header-dominates + reaches-header, unioned with
   the analyzed set) drives every region check.

Remaining no-pin loops: the D2 j-loop (refused — real `bl ___udivti3`
call, correctly), the D4 mi/si2 loops (no free callee reg — needs the
x12–x15 ext pool or fewer function-wide claims), mul_to's get_at/set_at
loops (raw shapes — needs cache-aware raw emission, not just
collection).

### Tranche 3 (2026-09-07): extension-pool borrowing + bracket hardenings

Borrow path for the x12–x15 caller-saved pool (`nir_regalloc.ts` +
`region_pool.ts` + `loop_promotion.ts` + `buffer_pipeline.ts`): the plan
offers ext regs after the callee pool (borrow-with-spill like callee);
ext pins never join `plan.callee_saved` (no prologue save — exclusion
rides `nir_caller_saved_claimed` with a had-claim restore at exit).
Bracket hardenings in the same pass: never re-borrow an open pin in a
nested loop (two brackets, one home slot); refuse under live
`buffer_base_cache`/`array_ptr_cache` homes (invisible to the dead set);
loop-promotion fresh claims and pipeline hoists avoid `region_pinned`;
`_param_N`/`_vn_N` machine temps never promote (forwarding elides their
declares — the pidigits garbage-index receipt); exit-less nested loops
fold into `region_loop_blocks`.

Result: pin set identical to tranche 2 in pidigits (D1×2 + D6×2),
outputs byte-identical across backends (pidigits, fannkuch, edigits
checked); fannkuch neutral; pidigits n=4000 0.53 vs 0.52 baseline
(noise floor). Full suite green default-ON (290 files / 2817 tests).
D4 status at commit: entries offered but refused at emission
(emit-time promotion holds x14/x15 under names outside the dead set).
Shelved with measurements (see FOLLOWUP.md): x15 reservation
(+0.02, lost the D6 pins), nested-loop pin refusal, collect_var_refs
coverage, promotion site-sharing.

### Tranche 4 (2026-09-07): dead-set fast path — D4 small-loop pins land

`pin_borrowable` vetoed plain occupants via same-source site keys on
other registers: the per-pin dead set already IS the register's full
occupant set, so a bound name found directly in it needs no
`source_keys` expansion (any same-source key on this register would be
an occupant, hence in the set — a pin is only offered when every
occupant is dead). The expansion stays for ambiguous/unknown names, so
every existing refusal (emit-time promotion claims, the edigits inner-`c`
case) still refuses. 11 lines in `region_pool.ts`.

Result: 4 more pins in pidigits (x14/x15 on the try_count, pi, cmp_i and
D5 loops — 8 total with D1×2 + D6×2), outputs byte-identical across
backends (pidigits, fannkuch, edigits checked); fannkuch 0.17
(unchanged); pidigits n=4000 neutral vs baseline (the new pins sit on
small loops — bracket overhead ≈ derivation savings). Full suite green
default-ON (290 files / 2817 tests).

The two hot D4 loops (mi-multiply, si2-subtract) get NO plan entry and
cannot get one by region refinement: every pool reg holds a genuinely
live occupant there (10 live values, 10 regs — the loops' own temps span
all of x12–x15), and the only dead-check refinement (sibling-aware
membership) is formally indistinguishable from the lru hole: a later
sibling reaches an earlier header via the outer back-edge exactly the
way a break-exiting nest reaches its own header, so no dom/reach rule
separates them — the union stays the sound ceiling. Landing mi/si2 needs
a different mechanism (spill-aware borrowing of live occupants, or fewer
live ranges via index-chain strength reduction — plan items 2–3).

### Tranche 5 (2026-09-07): region-scoped source variables

Plan item 2 of "Next tranches": loop-contained hot locals assigned from the
region-free registers by the planner itself, with the same bracket
bookkeeping. Landed in `nir_regalloc.ts` + `region_pool.ts` +
`build_while_loop_node.ts`: the per-loop free-register enumeration now
collects ALL region-free registers (same pool order, so pin choice is
unchanged — the first `min(receivers, 2)` still go to receiver pins), and
the remainder host the loop's CONTAINED locals: block-membership ⊆ the
loop's nesting-complete region, not live-in at the header (defined inside
the loop, dead after it — no entry load, no exit store-back), the usual
aliasing/ref/address-taken/tmp-name exclusions, and a traffic bar (reads ≥
2 or loop-weighted ≥ 8). Site-keyed locals (sibling-loop consts like
`shifted`/`val` — declared per loop) are included: the bracket publishes
their decl keys through a bracket-private `nir_site_allocs` copy and the
declare sites bind the source names (one binding per source name per
loop). The emitter borrows each var register exactly like a pin —
displaced-occupant spill/reload through the first plain occupant's home
slot, callee/ext claim bookkeeping, `region_pinned` refcount — and the
loop builder installs the bindings AFTER its `register_allocations`
snapshot, so the exit restore drops them with the bracket. Loops with raw
asm (liveness barriers) now refuse their whole region entry (barriers can
touch anything — protects ext-pool borrows).

Result on pidigits: **zero var firings — and that is the finding**. The
forensics pass over div_to/mul_to's lowered views shows every genuinely-
read loop-contained hot local already holds a function-wide register (the
allocator's interference sharing gave div_to 52 allocs; `q_hat`, `pi`,
`hv_carry`, `try_count`, `u_val`/`p_val`/`diff` are all `@alloc`), the
slot-resident staging consts (`shifted@N`) have their reads DELETED by
VN/forwarding (their per-iteration `str` to the slot is a dead store —
binding would be a wash), and the remaining slot traffic is inline-
expansion ABI marshaling (`str x0,[x29,#a]`/`ldr x1,[x29,#a]` around
div128 args) and preheader-computed VN bases — item 3's territory, not
var homes. The D2 j-loop itself has no region entry at all (its own live
ranges span every pool register). Suite green default-ON (291 files /
2822 tests incl. the new region-var shape + kill-switch + behavioral
both-backends tests); bench matrix byte-identical across backends;
fannkuch 0.18 unchanged. The mechanism is sound and fires where
candidates exist; pidigits simply has none left.

### Tranche 6 (2026-09-07): `_vn` invariant bases ride loop promotion

Plan item 3's completion. The chain-SPLITTING was already in place (the
vn_param_inits merge): the D4 store index emits `ldr x10, [base_slot]; add
x10, x10, mi` — invariant hoisted, induction live. What remained was the
base's own SLOT round-trip (`ldr x10, [x29, #base]` every iteration). Two
promotion-side gates blocked the base from riding a loop bracket:

- **Visibility**: promotion scanned the RAW AST, whose accessor arguments
  still show the unsplit chains — the hoisted `_vn_N` bases' reads lived
  only in the REWRITTEN trees the emitter builds (use-site splices +
  `vn_param_inits` init replacements). promote_loop_locals now walks the
  loop's host nodes and counts the replacement trees' reads too.
- **Eligibility**: `_vn_` temps were excluded wholesale (the pidigits
  garbage-index receipt: a FORWARDED single-use declare emits no slot
  store, so an entry load reads garbage). The refinement: promotion
  allows a `_vn_N` whose declare SURVIVED forwarding (multi-use by
  construction — the forwarder takes only single uses). `vn.temp_defs`
  (temp name → declare node) now rides the emit ctx; the gate refuses
  unknown names and forward-elided declares. `_param_N` stays excluded
  (its slot can be written inside the loop by hoisted allocations).

Result: mechanism sound, suite green default-ON (290 files / 2820
tests), bench matrix byte-identical across backends, pidigits n=4000
0.55-0.58 and fannkuch 0.17 unchanged. **pidigits' D4 loops did NOT
take it**: every pool register holds a loop-live occupant (mi/vv/
lo_prod/q_hat/...), and a live-across base interferes with every one —
the tranche-4 ceiling again; the codegen is instruction-identical modulo
frame-slot renumbering (spliced-read inflation made a few locals
eligibility-eligible; their pre-allocated slots shift the layout with no
code change). The enablement fires where registers exist; the D4 loops
need pool depth, not eligibility.

### Tranche 7 (2026-09-07): mul_to coverage investigated and refused

Plan item 4 asked to extend the region receiver collection to mul_to's
accessor forms (get_at/set_at/data_ptr). The forensics pass over
mul_to's lowered view REFUSES the premise, on three receipts:

1. **There is no derivation to pin.** mul_to's loops use the raw-pointer
   idiom: `digits.data` is hoisted ONCE before each loop (`const uint64
sp/bp/ap/scratchp = *.data_ptr()`) and the loops index through
   get_at/set_at, whose raw aarch64 bodies (`ldr x0, [x1, x2, lsl #3]` /
   `str x3, [x1, x2, lsl #3]`) NEVER READ THE RECEIVER. A region pin
   materializes `receiver.digits.data` — hoisting a derivation the loop
   is not performing is a net ADD (preheader work, zero removal).
2. **The contained locals are all register-resident already.** The
   per-loop var candidates (ov, lo_prod, hi_prod, result, c1, cur,
   cur2, c2, carry, i, j) all carry function-wide allocations; the only
   slot-read local in the hot small-b loop is `bp` — declared BEFORE
   its loop (notcontained by construction) and pool-blocked for
   promotion (all 10 pool registers hold genuinely live values — the
   tranche-4 ceiling again).
3. **The remaining per-call derivations (`get`/`set`, 15 in div_to) ride
   FIXED raw asm** (`ldr x0, [x0, #32]`) that consults no cache —
   exploiting them needs cache-aware raw emission (a raw-body
   substitution keyed on a pinned receiver), which the tranche-2 notes
   already flagged as its own project. Recording as the shelved
   follow-up: BigInt get/set raw bodies could consult
   `status.buffer_data_cache` (a BigInt pin pre-seeds it with
   `receiver.digits.data` — the same value data_ptr() returns) and emit
   `ldr x0, [pin, x1, lsl #3]` when the receiver is pinned. Modest
   surface (the small-b D2 loop + tail-normalization loops), real
   soundness surface (raw-body rewriting) — needs its own receipts.

No code change ships for item 4; the accessor-form receiver extension is
formally a no-op-to-regression for these shapes. This closes the
"Next tranches" list: item 1 resolved (soundness, default ON), item 2
landed (tranche 5), item 3 landed (tranche 6), item 4 refused with
receipts (this section).
