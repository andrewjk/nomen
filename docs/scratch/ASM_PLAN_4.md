# ASM_PLAN_4.md — evaluation methodology + remaining steps

> Follow-up to ASM_PLAN.md, ASM_PLAN_2.md and ASM_PLAN_3.md (all fully
> discharged). This document consolidates two things that were previously
> scattered across those files:
>
> 1. **The evaluation methodology** — how perf work on the aarch64 backend
>    is planned, measured, and landed (so the next session does not have to
>    reassemble it from three documents' histories).
> 2. **The remaining steps** — open levers, structural blockers, and
>    recorded-but-unfixed items, with the receipts that gate each one.
>
> Constraint unchanged: **the aarch64 artifact stays hand-written assembly —
> no clang/LLVM in the aarch64 build.**

## Where things stand (snapshot)

**Fresh receipts 2026-09-05** (interleaved best-of-7 medians, release,
outputs byte-identical across backends; load avg 8 — arms interleaved, so
ratios hold):

| bench                       |   ours | C `-O2` |       ratio | status                                             |
| --------------------------- | -----: | ------: | ----------: | -------------------------------------------------- |
| nbody 5M                    | 338 ms |  218 ms |       1.56× | **at target** (float-bits forwarding was the last) |
| pidigits n=4000             | 684 ms |  372 ms |       1.84× | 1.5× criterion unmet; structural levers below      |
| mandelbrot                  |      — |       — |      ~1.25× | last ratio at PLAN_2 tranche C; neutral since      |
| spectral-norm               |      — |       — |       ~1.8× | serial denom chain; post-D-tranche accounting      |
| fannkuch/binarytrees/nsieve |      — |       — | neutral-ish | profile flat, no dominant label                    |

Hot-function census from the same run (ours = whole function; clang's
pidigits functions are unrolled/replicated, so its STATIC totals mislead —
read its hot loop, not the totals):

| function (ours vs clang) | instrs    | sp      | movx    | mem      |
| ------------------------ | --------- | ------- | ------- | -------- |
| nbody `advance`          | 189 vs 59 | 35 vs 0 | 34 vs 3 | 81 vs 15 |
| nbody `energy`           | 161 vs 46 | 39 vs 0 | 22 vs 3 | 76 vs 8  |
| pidigits `div_to`        | 112 vs —  | 15 vs — | 52 vs — | 31 vs —  |
| pidigits `mul_to`        | 36 vs —   | 13 vs — | 11 vs — | 17 vs —  |

The nbody shape is unchanged in kind from PLAN_3's D1/I accounting: clang
touches the stack **zero** times; our `advance` spends ~116 of 189
instructions on sp/mov/memory staging around 57 FP ops (clang: 25 of 59).

Success criterion (written in ASM_PLAN_3, still standing): pidigits and
nbody within **1.5×** of the C `-O2` artifact, **or a written structural
blocker per remaining multiple**. nbody is at the line; pidigits owes
either a winning tranche or that written accounting.

## Evaluation methodology (consolidated)

### The receipts-first principle

Never plan a tranche from intuition. For any `bench/nomen/<name>.nm`:

1. **Emit both artifacts** (tsx, using the repo's own build; the driver is
   `bench/compile_nomen.ts`):
   - aarch64: `build(parse(join("bench/nomen/<name>.nm", "core"), lib),
{ arch: "aarch64", audit: true })` → write `code` to `main.s`.
   - C `-O2`: `build(..., { arch: "c", audit: true })` → write
     `code + companion` to `main.c`, `headers` to `main.h`, then
     `clang -O2 -S -o main-O2.s main.c` (one input file per invocation).
2. **Extract the hot function** from each text: slice from the function
   label (`^<name>:` ours; `^_<name>:` clang's) to the next function-label
   anchor (`^main:` ours; `^_[a-z]` clang's — for clang files the end
   anchor MUST be underscore-prefixed only, else `LBB`/`Lloh` locals and
   the start label itself truncate the slice). Two traps: cutting at the
   first `ret` truncates multi-exit functions (early returns), and clang
   inlines/unrolls aggressively — if the function vanishes, the hot code
   moved into its caller (analyze the caller), and for unrolled functions
   (pidigits limb loops) the STATIC total is meaningless: compare hot-loop
   bodies, not whole-function totals.
3. **Census per function body** (skip label/directive/comment lines):
   - total instructions;
   - FP ops (opcode starts with `f`) — the compute floor;
   - branches (`b`, `b.cc`, `cbz/cbnz`, `tbz/tbnz`);
   - `sp` mentions — slot traffic;
   - `mov x` shuffles — staging/parameter traffic.
4. **Read the two bodies side by side.** The counts rank the gap; reading
   the asm names the pass. A loop where clang has straight-line copies =
   unrolling; `ldr/str [x29, #N]` around every operand = register
   allocation; `fmov` domain crossings = staging; repeated identical
   address computations = CSE/address pipeline. This step is mandatory —
   at least four tranches were REDEFINED by reading the actual clang output
   instead of trusting the census (B: operand-order spills, not slots;
   PLAN_3 D step 2: field-pair SLP, not lanes-over-j; E: div128 not on the
   critical path; K: hoists land but the loads were never hot).
5. **Profile the runtime**, not just the text: `sample <running binary>`
   on macOS names the hot labels (used to move the pidigits profile to
   Knuth-D, and to detect FLAT profiles — a flat post-tranche profile is
   the receipt that no single further fast path moves the needle).
   `NOMEN_PIPE_DBG` exists for pass-level debug output (tranche K).

The whole census is a throwaway ~60-line tsx script (the 2026-09-02 copy
lived in `$TMPDIR/plan3/census.ts`; recreate per session, do not check in).

### Timing discipline

- **Real bench sizes only** (args from `bench/benchmark.sh`: mandelbrot
  n=1000/2000, pidigits n=4000, nbody 5M, spectral-norm n=1500, fannkuch
  n=11, binarytrees n=15–18, nsieve n=12). Toy sizes lie.
- **Interleave arms.** This box has noisy background load (load avg has
  hit 3–30 across sessions). Never trust a single run; check `uptime`
  first; A/B arms interleaved; **medians of ≥5** (≥7 preferred; narrow
  wins used best-of-45 — flag-form tranche J).
- **Arm-swap test**: a win that flips sign when arms swap is noise.
  Several "wins" were discarded this way (spectral +2.0% that did not
  reproduce; fannkuch −4% reading up as +0.6%).
- **Outputs byte-identical** between arms on every bench and size — any
  output diff is a soundness bug first, a perf question second (caught:
  the fannkuch occupancy corruption, the unroll induction bypass checksum
  1024, the array-cache stale pin, `-inf` from a stale float-forward
  record).
- Absolute times are NOT comparable across sessions/days (machine/load
  drift); the A/B arms in one session are the receipt. Note the load avg
  in the RESULT block.

### Standing invariants (every tranche, no exceptions)

1. **No regressions across the bench matrix** — all benches, ±noise.
2. **Full suite green** (281 files / 2749 tests at tranche M; `npm test`,
   or `npx vp test`).
3. **Kill-switch off = byte-identical output.** Every pass ships behind a
   `set_*_enabled` toggle, default per receipts (neutral foundations stay
   ON when they are the seam for future passes — e.g. forwarding, value
   numbering; measured-loss machinery stays OFF — e.g. unrolling, buffer
   pipeline). The byte-identity tests assert exact restoration.
4. **Behavioral proof**: at least one test runs the built binary and
   asserts exact output, on both backends where ownership semantics are
   involved.

### Byte-identity harness rules

- Cursor-dependent passes (consume multiple statements or depend on the
  NIR emission cursor: NEON, loop unrolling, site promotion, cset fuse,
  flag-form carry fold, value numbering) are held **OFF in both arms** of
  `expect_byte_identical` and the bench corpus test — the delegation arm
  structurally cannot reproduce a consumed span.
- Cross-backend output comparisons (aarch64 vs C binary output) are the
  correctness receipt when both backends must agree; LC_UUID link
  randomness in binaries is expected diff noise.

### Proof-of-execution: mutation checks

When new dispatch arms or emitters land byte-identically (so tests cannot
distinguish them from the fallback), inject a marker (e.g. a bogus 16-byte
instruction) into the NEW path, confirm every probe program picks up
exactly one marker, then revert. This caught "shape silently fell back to
the AST walk" several times during the NIR emission tranches.

### Tranche landing checklist

A tranche lands with ALL of:

- [ ] Census before/after (instruction-level, hot loops) — or an explicit
      "census-neutral, foundation/seam" justification.
- [ ] Interleaved A/B timings at real bench sizes, medians ≥5, outputs
      identical, load avg noted; arm-swap for narrow readings.
- [ ] Kill-switch with byte-identical restoration test.
- [ ] Tests that FAIL on the pre-tranche code (verified, e.g. via
      `git stash` of the touched files).
- [ ] Behavioral run test (exact output, both backends when relevant).
- [ ] RESULT block written into the plan doc (or its successor) with the
      honest accounting — including neutral/negative outcomes and the
      profile's answer to "why" (sample receipts).
- [ ] Anything found broken on the way that is out of scope → FOLLOWUP.md.

### Soundness debugging recipe

When a built binary misbehaves (hang/wrong output/SEGV): build both arms
(kill-switch on/off), diff the `.s` (register-renaming-only diffs point at
claim bookkeeping, not instruction stream), and instrument the suspect
pass (share traces, stack traces on emit sites). Every regalloc-era bug
was found this way; the recurring root causes are claim-system races
between the three claim channels (function plan, loop promotion, site
hook) and inline-expansion leaks (cleared maps, leaked used-sets, swapped
param-type maps).

## Remaining steps

Ordered by expected value; each entry names its gate.

### 1. Field-pair SLP pass (nbody) — the D-step-2 conclusion — **GATE PASSED 2026-09-05, GO**

Clang's `advance` win is field-pair SLP within ONE struct body — `(x,y)`,
`(vx,vy)` as `.2d` lanes, `faddp` horizontal sums, q-load/q-store of
adjacent field pairs — NOT lanes-over-j (analyzed unprofitable for AoS:
gathers cost more than they save). It is a different pass class
(superword-level pattern matching over consecutive statements), on the
order of the NEON vectorizer itself.

**The D2 blocker was wrong — corrected 2026-09-05.** PLAN_3 D2 closed this
pass because "the Q-form LDR immediate must be ×16, and Nomen's (x,y) sits
at #8". True for `ldr q` — irrelevant, because the UNALIGNED form
`ldur q/stur q` (simm9 offset, no ×16 rule) encodes it, and clang's own
`advance` pairs (x,y) at exactly `ldur q2, [x11, #8]` **on the same
vt-prefix layout** (the C backend emits the identical 8-byte prefix; all
field offsets match ours: x@8, y@16, z@24, vx@32, vy@40, vz@48, mass@56).
No pairs are layout-blocked; the "win shrinks to (vx,vy)" conclusion is
void.

Gate receipt (2026-09-05 census of the real bodies, same layout both
sides):

- Clang inner j-iteration: **30 instructions** — `ldur q16, [x12, #-48]`
  (other body's field pair), `fsub.2d`/`fmul.2d`/`faddp.2d` (two axes of
  the distance, third scalar), `fsqrt` scalar, then the RMW velocity pair
  as `ldur q17` + `fmul.2d`×2 + `fadd.2d` + `stur q16` (5 instructions
  for two axes), scalar third axis, and the j-loop REMAINS a loop.
- Ours (`.while_3` in `advance`): **~65 instructions** per inner
  iteration, mapping 1:1 onto the missing transforms:
  - body_j velocity RMW: 3 axes × 11 instructions (per-axis
    `mov x0,x26; ldr; str [sp,#-16]!; fmul; fmul; fmov d1,d0; ldr [sp],#16;
fadd; fmov x0,d0; mov x2,x0; str`) = 33 → pair form is ~11;
  - distance: 3 dead `mov x0, x26` prefixes (the `.at()` contract
    marker — provably dead when the address is already pinned) + 5
    scalar dist² ops → q-load + `fmul.2d` + `faddp.2d` ≈ 5 → ~4;
  - body_i accumulator (`d13/d14/d15 -= …`): 3×3 → pair ~3 + scalar 3;
  - d0-protocol fmovs around `fsqrt` (2) → dest-hint territory (landed
    machinery).
- Projected inner iteration after SLP: ~30 (parity with clang);
  whole-function ~189 → ~90–110. The `.while_4` slice (the sun's
  per-axis 9-instruction pattern ×3) shrinks the same way.

Pass shape (when built): statement-level SLP over the NIR emission path —
pairs of adjacent same-shaped float ops fed by adjacent field
loads/stores of one struct → `.2d` forms with `ldur/stur` q access;
rides the landed address pipeline (tranche A pins) and float dest hints;
same harness rules as every cursor-dependent pass. NOT an extension of
the induction-driven loop vectorizer; reductions/`faddp` only where the
source shape is the two-axis distance sum.

#### RESULT — field-pair SLP tranche 1 (landed 2026-09-05)

Shipped as `src/build_aarch64/slp_pair.ts` + pair-aware allocation in
both allocators (`plan_nir_registers`, `promote_loop_locals`) + the
`fmul.2d`/`faddp` square-sum hook in `build_float_tree`.

- **Register model (the tranche's hard-won fact):** adjacent d-registers
  are NOT the lanes of one q-register — `vN.d[1]` has no d-name. A pair
  is `a` in dN (lane 0, its normal promotion) and `b` in `vN.d[1]`
  (lane-resident, deliberately NOT register-promoted). Scalar writes to
  a D register zero the upper half of the V register, so: every fused
  register-pair write re-syncs b's slot (`mov v0.d[0], vN.d[1];
str d0, [x29, #slot]`); the write gate refuses pairs where a or b is
  assigned by a non-pair statement inside the loop (fixpoint drop); the
  lane register dN+1 is blocked (never assigned, rides
  `callee_saved_regs_used` so inline expansions cannot claim it); pair
  v-regs are reserved against the float-tree temp pool
  (`slp_pair_vregs`, budget-adjusted); a NEON vector plan is dropped
  when v8 hosts a pair. First cut assumed consecutive-d = lanes and
  read garbage in lane 1 (probe program summed 30 instead of 45); the
  lldb receipt named the model error.
- **Planning:** `slp_pair_hints` (register-blind shape scan with
  group-continuation lookahead — bi_z@z + vx@vx are text-adjacent AND
  field-adjacent but must not pair) + write-gate fixpoint. Function
  level pairs (both members fn candidates): advance's (vx,vy) and
  (dx,dy); loop level: (bi_x,bi_y). Unregistered pairs fall through to
  the next scope — the scan is shared.
- **Fuses** (2 statements each, at the NIR dispatch): declare pair
  (`ldur q` / `.2d` op + slot sync), var-assign pair (in-place target
  pair, operand order preserved, broadcast scalars as `vN.d[0]` — the
  by-element operand must be the FINAL source; commutative ops swap,
  subtraction dups), field-RMW pair (`ldur q0` + chain + `stur q0`),
  plain field-store pair (`stur qPair`), square-sum (`fmul.2d` +
  `faddp`, lane order = the scalar left+right add order). All emission
  forms parse under the asm IR (arrangement-suffixed registers;
  `ldur/stur` added to MNEMONICS) so the phase-2 float-forwarding and
  dead-stage-move passes keep working — an unparseable `.2d` line made
  the DCE conservative and left a stale `fmov x0, d0` behind.
- **Timings** (nbody 5M, interleaved best-of-7 medians, arm-swapped,
  load avg 4, outputs byte-identical across all three arms):
  ours 302.6 → 248.5 ms (**−17.9%**, arm-swap −18.5%); vs C -O2
  **1.36× → 1.12×**. advance inner loop 65 → ~43 instructions
  (clang 30). No regressions: spectral-norm −0.2%, fannkuch +0.2%,
  mandelbrot +2.1% (all output-identical, within noise).
- **Tests:** `test/slp_pair.test.ts` (7: fused forms present — fail on
  pre-tranche code; kill-switch restores scalar-only text; behavioral
  run on BOTH backends agreeing). Byte-identity harnesses hold the pass
  off in both arms (cursor-dependent). Full suite green.
- **Remaining gap to clang (~43 vs 30):** the d0-protocol fmovs around
  `fsqrt`, the third-axis (z) scalar RMW's spill protocol (12
  instructions), the per-iteration `.at()` address re-derivation, and
  the dead `mov x0, xPin` contract markers (a `mov x0, xN` DCE would
  take 4 more). Candidate tranche 2 material.

#### RESULT — SLP follow-on micro-tranches (2026-09-05)

Two of the four candidates landed; two parked with receipts.

- **Scalar float field RMW fast path — LANDED (+10.7%)**
  (`build_assignment_node.try_float_field_rmw`): the non-paired member
  of a field-RMW group paid the both-complex spill protocol — old value
  spilled around the RHS, result round-tripped x0 → x2 (10-11
  instructions). With the `.at()` base pinned and the RHS side
  call-free, it is now rhs → d0 (float tree), `ldr d1, [base, #off]`,
  one `fadd/fsub` (operand order preserved; `+` commutes bitwise),
  `str d0, [base, #off]` — 5 instructions. nbody 5M: 244.3 → 218.0 ms
  (**+10.7%**, interleaved best-of-7, arm-swapped) — **0.99× of C -O2:
  the success criterion is now MET with parity.** Inner loop ~37
  instructions (clang 30).
- **Dead copy-move elimination — LANDED, DEFAULT-OFF** (measured-loss
  convention). `eliminate_dead_copy_moves` in asm_opt.ts prunes
  `mov xD, xS` whose destination is neither live nor control-flow
  tainted (two-set backward scan: labels/branches/rets taint all —
  the linear universe reset got switch-arm joins wrong and corrupted
  switch lowering before the taint model; `bl` reads its argument
  registers — deleting them pruned arg staging and segfaulted; `ret`
  clears, plain `b` must NOT — fat returns flow through the target).
  20 markers die in nbody, but the measurement is **−1.3…−1.5%**
  (removed markers executed in the OoO shadow; layout drift dominates).
  Ships sound, fully tested (9 unit tests), opt-in via
  `set_dead_move_elimination_enabled`. The work also fixed a latent
  liveness-cancellation bug in the float stage-move pruner's reads
  (name-filtered reads cancelled def-and-read registers —
  `add x0, x0, x1` reported zero reads; now positional).
- **Parked: d0-protocol around `fsqrt`** — `fmov d0, d29; fsqrt;
fmov x0, d0` is already the forwarding-collapsed minimum; beating it
  needs raw-inline bodies to take float args in d-registers
  (convention change in core/System raw blocks + the naked-inline
  arg marshalling). ~2 instructions/iteration.
- **Parked: array-base pin** — the ref-param base reload
  (`add x9, x29, #0; ldr x9, [x29,#0]`) at each element-pin fill is
  loop-invariant and pinnable (1 instruction/fill saved), but the DCE
  receipt shows this class of micro-removal measures at noise or
  worse; not worth a tranche without a new receipt.

### 2. Cross-block / cross-iteration value numbering + register coalescing (pidigits)

The K/L/M-survey lever, named "one order larger than a tranche": the
current reuse windows are statement-list scoped (straight-line, taint-
killed at calls/branches/joins), while clang keeps ~10 live scalars in
registers across the whole loop body. Components:

#### RESULT — copy coalescing + derivation memoization, tranche 1 (landed 2026-09-06)

Shipped as `src/build_aarch64/asm_coalesce.ts` (`coalesce_copies`, kill-switch
`set_copy_coalescing_enabled`, default ON; wired into build.ts after
`eliminate_dead_copy_moves`, before audit wrapping; runs over the final text,
re-validated by the phase-1 lift). NOT the full allocator-level pass — the
first slice of it, delivered at the text level where the soundness fences are
region-local:

- **Copy propagation**: `mov xD, xS` records D == S; reads of D rewrite to S
  until S or D is redefined or a region boundary. w/x families exact-name,
  sibling-aware kills; writeback memory forms and lines whose pristine
  render round-trip fails are never rewritten (the lift drops shifted-ALU
  shift qualifiers — the round-trip guard is what keeps `add x0, x1, x2,
lsl #6` intact).
- **Flagged-move deletion**: a backward two-set live/taint scan (the
  eliminate_dead_copy_moves model) deletes exactly moves whose destination
  is dead below; taint at joins is the TARGET BLOCK's upward-exposed read
  set (walked to depth 4, memoized) instead of the universe — the universe
  taint from a distant `ret`/`b.cond` had been blocking every staging-move
  deletion in loop bodies.
- **Derivation memoization**: the consecutive `mov xA, xB / add xA, xA|xB,
#o1 / ldr xA, [xA, #o2]` receiver-path sequence is memoized (base + off1
  - off2, holders = the sequence register + its tail copies); an identical
    later sequence with a live holder snapshot deletes its three instructions
    plus the tail copy. This crosses the boundary the statement-level staging
    pins cannot: the flag-form carry `if` taints the statement window but
    emits NO branch, so two accessor statements share one straight-line text
    region.
- **Drive-by validator fixes (the table is the contract)**: `umulh` and
  `movn` added to MNEMONICS and GNU numeric local labels (`1f`/`2b`)
  accepted as label operands — BigInt's raw `mul_wide_hi` body had been
  failing the phase-1 lift silently on every build (`build_errors` are not
  surfaced by the bench driver); the unparseable `umulh` line also reset
  all coalescer state mid-loop.
- **Four soundness receipts caught during bring-up** (build both arms, run,
  diff): (1) `reads_of` name-matching hid dest-and-source reads
  (`eor x24, x24, x23`) so the XOR-swap's load-bearing `mov x24, x0` was
  deleted — now position-based like the existing pass; (2) merkletrees
  segfault from `bne`-spelled conditional branches (ARM32-style aliases)
  missing both branch arms' exposed-read unions; (3) the exposed walk
  stopped at `bl` ("reads after a call are defined by the convention") —
  wrong for callee-saved registers, which flow through; (4) a mov's own
  source must not substitute into a self-move (`mov x0, x19` → `mov x0,
x0`), preserving the deferred-self shape.

Census (instruction lines per loop, pidigits div_to/mul_to; base = pre-
tranche):

| loop                             | before | after |
| -------------------------------- | -----: | ----- |
| div_to D3 correction (.while_22) |     33 | 24    |
| div_to D4 multiply (.while_24)   |     38 | 28    |
| div_to D4 subtract (.while_25)   |     32 | 26    |
| mul_to single-limb (.while_9)    |     44 | 40    |
| mul_to schoolbook (.while_12)    |     59 | 54    |

**RESULT (interleaved best-of-7, load 3–5, outputs byte-identical across
backends on every bench):** pidigits n=4000 0.63 → **0.55 s (−12.7%)** —
now ~1.57× vs C `-O2` (was 1.89×). Bench matrix neutral: nbody 5M,
mandelbrot, spectral-norm, binarytrees, nsieve ±0; fannkuch +0.7% (noise).
Full suite green (288 files / 2805 tests) with `test/copy_coalesce.test.ts`
(9 tests: substitution, alias-kill, derivation deletion + memo-kill fences,
round-trip guard, kill-switch byte restoration, behavioral on both
backends); the cset/promoted-dest/field-marshal/call-marshal/access-staging
shape tests updated to the new canonical forms (their properties intact).

#### RESULT — loop-carried slot promotion, tranche 2 (landed 2026-09-06)

Shipped as `src/build_aarch64/asm_loop_promote.ts` (`promote_loop_slots`,
kill-switch `set_loop_slot_promotion_enabled`, default ON; wired into
build.ts BEFORE coalesce_copies — the renames feed its substitution). The
carry slot round-trips named by the tranche-1 accounting, delivered at the
same text level:

- **Cycle model**: cycles are [header label … unconditional back-edge]
  ranges — the back-edge may sit past `.while_update_N:`/`.for_inc_N:`
  labels. Innermost-first processing with line ownership (a range
  overlapping an already-promoted inner cycle is skipped); no
  `bl`/`blr`/`svc`/`ret` inside (calls clobber the promotion registers).
- **Renaming**: all 64-bit `ldr`/`str` accesses of a read+write
  `[x29, #N]` slot inside the cycle become `mov`s through x16 (then x17);
  entry loads accumulate before the header label (fall-through only — the
  back-edge skips them), sync stores after each exit label. Provenance
  checks: every jump to the header and to each exit target must originate
  inside the cycle, or the slot is refused.
- **The carry-increment collapse**: `cset xT, cc` … `add xA, xA, xT` …
  `mov xH, xA` (xH a promotion register) folds to `cinc xH, xH, cc` —
  windowed (the add may sit several harmless instructions after the cset,
  the home update several after the add), with flag-writers,
  branch/label/call lines, and any other reader/writer of xT/xA/xH
  refusing the fold. Removing the cset is flag-safe because nothing
  between writes flags.
- **Escape/disqualification rules**: sub-width accesses, `ldp`/`stp`, or
  an `add xK, x29, #N` address build anywhere in the function
  disqualify slot N; read-only slots are untouched.
- **Two soundness receipts caught during bring-up** (build both arms,
  run, diff): the emit_nir behavioral belt-and-braces (range-for +
  break/continue) printed garbage because multiple promoted slots'
  ENTRY LOADS overwrote each other (only the last rename's load
  survived — the other promotion register stayed uninitialized);
  and the fold's `is_harmless` initially rejected the consumer `add`
  itself (it reads xT by definition) — consumers match before the
  harm check.

**RESULT (interleaved best-of-7/9, arm-swapped on the narrow readings,
load 3–5, outputs byte-identical across backends on every bench):**
pidigits n=4000 0.64 → **0.55 s (−14%**, ~1.55× vs C `-O2` — the carry
block is 4 register instructions with zero memory ops per D4 iteration);
**fannkuch-redux n=11 2.96 → 2.13 s (−28%** — its permutation loops carry
the same slot shape; output verified identical at n=11). Bench matrix
neutral: nbody 5M, mandelbrot, binarytrees, nsieve ±0; spectral-norm
0.17↔0.18 flips with arm order (noise). Full suite green (289 files /
2812 tests) with `test/loop_promote.test.ts` (7 tests: rename+entry/sync
shape, read-only/escape/call/sub-width refusals, kill-switch byte
restoration, behavioral carry-propagation run on both backends).

What remains for the allocator-level pass (item 2 proper): the carry slot
round-trips (multi-written loop-carried scalars — pool exhaustion keeps
`mul_carry`-class names in slots), per-region reassignment of the
callee-saved pool, and receiver-path materialization ACROSS calls and
loop iterations (the memo is region-scoped by design). The asm-level slice
is the floor those build on; pidigits' residual 1.57× decomposes into the
same receipts as the 2026-09-05 accounting, now with the address ALU and
staging halves of the D4 loops largely gone.

- **Receiver-path re-derivation**: `mov x9, x22; add x9, x9, #24; ldr x9,
[x9, #8]` twice per D4 iteration — 6 of ~37 lines — is a PATH, not an
  arithmetic chain, so neither the L staging pins nor the M `+`-chain
  hoist can touch it. The K machinery (`buffer_pipeline.ts`, kept default
  OFF) is the designated seam; a comprehensive address-materialization
  pass would drive it. Why K measured neutral: the removed loads were L1
  hits overlapped with `mul`/`umulh`/`subs` — the pass only pays if it
  frees REGISTERS or eliminates address ALU, not loads.
- **Carry slot round-trips** (#288-class multi-assignment carries) and the
  D5 add-back loop (62 lines, untouched by everything since J).
- **Store-site index rebuild** where an int tree or call taints the
  staging window, and the update block's two dead `add x1, x29, #N`.
- Coalescing into the NIR allocator (stages 1–3 substrate: live ranges,
  interference, site keys) rather than around it — the M pass is the
  plumbing; the missing piece is cross-statement live ranges for
  TEMPORARIES (values with no source name), still not expressible.

Gate: a sample + census receipt showing address ALU (not L1 loads) on the
critical path of the Knuth-D loops post-L/M.

#### GATE RECEIPT — passed 2026-09-05 at HEAD (post SLP tranche)

- **Sample** (pidigits n=40000, 3s): hottest labels are the inlined
  Knuth-D bodies — `.end_while_19` subtree 669/2277 samples
  (`.while_24` 270, `.while_22` 206, `.while_25` 192), `end_28` subtree
  605 (the mul_to/school limb loops), `.end_while_17` 373,
  `BigInt_ensure` 268. The profile is NOT flat — one lever class
  dominates.
- **Census of `.while_24`** (the D4 single-divisor inner loop,
  ~40 instructions): the receiver path
  `mov x9, x22; add x9, x9, #24; ldr x9, [x9, #8]` is derived TWICE per
  iteration (8 with the x11 copies); the store index is rebuilt from a
  taint-survivor slot (`ldr x3, [x29, #264]` + 3 adds); the carry
  round-trips a frame slot (`ldr [x29,#288] / str / cset / ldr`);
  copy shuffles (`mov x2/x3/x10/x12`) pad the rest. True memory loads: 4. **~22 of ~40 instructions are address ALU, staging, or slot
  traffic — the gate's condition holds.**
- **But the named seam is wrong for this code**: pidigits has ZERO
  Buffer accesses — the receiver paths are inline-expanded
  `.get/.set` accessor marshalling inside BigInt's Nomen-level limb
  loops (`self.digits` derivations), not `Buffer.data` loads.
  `buffer_pipeline.ts` keys on Buffer targets and hoists nothing here
  (verified: `NOMEN_PIPE_DBG` finds 0 accesses). The lever therefore
  needs the comprehensive address-materialization/coalescing pass in
  the NIR allocator (cross-statement live ranges for TEMPORARIES) —
  confirmed **one order larger than a tranche**.

### 3. pidigits accounting closure — WRITTEN 2026-09-05 (criterion unmet at 1.87×)

Fresh interleaved medians (n=4000, best-of-7, load avg 4, outputs
byte-identical): ours 638.1 ms, C -O2 341.7 ms — **1.87×** (the 1.5×
criterion is unmet). Per the success criterion, the written structural
accounting per remaining multiple:

1. **Receiver-path re-derivations + store-index rebuild (dominant).**
   ~22 of ~40 instructions in the hottest D4 iteration are address ALU,
   staging copies, or slot traffic (census above); the sample puts that
   loop's subtree at ~45% of runtime. Structural blocker: the
   per-statement emission model has no cross-statement live ranges for
   TEMPORARIES (values with no source name). The receiver path is a
   PATH (`x9 = x22+24; ldr [x9,#8]`), not an arithmetic chain — the L
   staging pins and the M `+`-chain hoist structurally cannot touch it;
   the accessor bodies that re-derive it are inline-expanded at each
   call site, and hoisting the derivation once per loop requires the
   allocator-level coalescing pass named in (2). Not a flag-flip: the
   K machinery is Buffer-keyed and provably does not apply.
2. **div128 `___udivti3` call boundary.** Measured NOT dominant
   post-cset-fuse (tranche E survey); unchanged at HEAD — the sample
   shows the div128 call sites outside the top subtrees.
3. **Smeared Knuth-D memory traffic.** The carry slot round-trip
   (`str/ldr [x29,#288]` around `cset`) and hoisted-temp slot reads
   (`[x29,#264]`) are the per-statement model's materialization tax —
   subsumed by the same missing temp live ranges as (1).

Closure: pidigits stays above the line pending the coalescing pass.
That pass, when planned, inherits these receipts: attack the receiver
PATH materialization + temp live ranges in the NIR allocator (stages
1–3 substrate), NOT the loads.

### 3. pidigits accounting closure

Either a winning tranche from (2), or write the structural blocker per
the success criterion. The residual ~1.85× currently decomposes into: the
receiver-path re-derivations above, the div128 `___udivti3` call boundary
forcing callee-saved residency (measured NOT dominant post-cset-fuse —
tranche E survey), and smeared Knuth-D memory traffic the per-statement
model materializes. The written accounting should quote those receipts.

### 4. Smaller named items (each its own small tranche, receipt-gated)

- **Shifted-index vectorization** (`load(i + 1)`): soundness design
  exists (per-element event-order rule) but BLOCKED UPSTREAM — the
  checker's bound verifier cannot prove `i >= 0 && i + 1 < cap` under any
  guard shape. Extending the verifier is memory-safety-critical work; no
  shifted program reaches the planner today.
- **Byte (`.16b`) element kinds**: `load_T`/`store_T` are not in the
  scalar inline fast path (they emit real calls) — needs scalar-path
  inlining first.
- **Traffic flip** — **LANDED 2026-09-05**: `traffic.ts` now counts
  flow-arm/spawn-arg reads (they execute on every evaluation; the
  allocators' read inputs are honest). Parity pin in `test/nir.test.ts`
  flipped to pin the NEW behavior (`q` reads = 1). Full suite green;
  nbody/spectral-norm output byte-identical to pre-flip (no flow/spawn
  in their hot paths), pidigits/binarytrees timings unchanged.
- **Float promotion pool in v16+**: effectively SUPERSEDED — the float
  expression-tree allocator now occupies v16–v31 for call-free trees; any
  new pool must disjointly split against it (the x10/x11 tree-vs-pin
  collision is the int-side precedent).
- **Cross-backend argument-evaluation-order divergence** (aarch64
  right-to-left vs C left-to-right) — **CHOICE DOCUMENTED 2026-09-05**:
  the divergence stays, deliberately. The aarch64 right-to-left walk is
  load-bearing: args spill to stack slots in walk order, so walking
  from the last argument makes every register-arg's slot land at its
  final depth with no fixup pass; reversing it would re-touch every
  call site's marshalling for corpus-wide byte churn. The observable is
  a program whose sibling arguments carry side effects the checker does
  NOT hoist (plain `f(g(), h())` calls) — computed args are hoisted to
  `_param_N` temps in source order by the checker, so both backends see
  side-effect-free leaves there. The C and aarch64 backends therefore
  may differ ONLY on non-hoisted side-effecting sibling args; that is
  the documented contract, not a bug to fix.

### 5. Phase-3 leftover duplication candidates (refactor-only, no urgency)

From ASM_PLAN.md phase 3, still unextracted:

- `collect_allocations` walk (`emit_allocations.ts` both backends) — needs
  an options flag (C collects LetNode values for statement hoisting).
- Owning-Buffer element specialization decision (`has_string_fields` could
  move to `build_common/` alongside `destroy_analysis.ts`).

**DONE 2026-09-05**: both extracted — `build_common/has_string_fields.ts`
(shared by both backends' owning-Buffer specialization) and
`build_common/collect_allocations.ts` (the shared walk; `let_values: true`
on the C arm, off on aarch64 — byte-stable, full suite green). This
section's list is empty; future duplication goes to FOLLOWUP.md.

## If resuming

1. Run the census + sample receipts for whichever lever above you target
   (recipe above; script is throwaway, recreate it).
2. Confirm the receipts still hold at HEAD — several surveys went stale
   when an earlier tranche moved the profile (tranche E's premise died
   when B flattened the profile; K's when L landed).
3. Follow the tranche landing checklist. Write the RESULT block here or in
   a successor plan doc; keep the honest accounting, including neutral
   outcomes and reversions.
