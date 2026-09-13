# ASM_PLAN_7.md — the remaining aarch64 gap: evidence and targets

> The question, after the ASM_PLAN_2→6 arc: why did the last tranches stop
> showing wins, and why are ALL aarch64 benchmarks still slower than the C
> backend? Constraint unchanged: **the aarch64 artifact stays hand-written
> assembly — no clang/LLVM in the aarch64 build.**

## The measured gap (2026-09-08, HEAD + tranches 5–6, interleaved)

- **pidigits n=4000**: aarch64 **0.50 s** vs C backend **0.33–0.34 s**
  → ~**1.5×** (fannkuch n=11: 2.07 vs 1.28 → ~**1.6×**).
- **spectral-norm n=1500**: aarch64 **0.18 s** vs C backend **0.08 s**
  → ~**2.25×** (outputs byte-identical).

The C baseline is clang `-O2` compiling the C backend's output — i.e. a
world-class optimizing compiler over the same source. The aarch64-vs-C gap
is exactly "our hand-rolled codegen vs an integrated SSA optimizer".

## Part 1 — the pidigits evidence

### The same loop, side by side

The D3 q_hat multiply loop (the try_count `pi` loop), our build vs the C
backend's compiled `div_to`:

**clang -O2 (C backend)** — 9 instructions/iteration:

```
ldr   x14, [x12]              ; vv — pointer-walked, no index math
mul   x15, x14, x21
umulh x14, x14, x21
adds  x15, x15, x11           ; carry in flags
cinc  x11, x14, hs
str   x15, [x12, x19]         ; x19 = pre-scaled offset, computed ONCE
add   x12, x12, #8            ; pointer bump = the induction
subs  x13, x13, #1
b.ne
```

**Ours** — 21 instructions/iteration:

```
ldr   x1, [x29, #336]     ┐
cmp   x1, x23             │
b.ge  .end                │
ldr   x10, [x29, #336]    │← the induction `pi` lives in a FRAME SLOT:
ldr   x0, [x9, x10, #3]   │  read 3× + update = 6 memory ops/iteration
mov   x12, x0             ┘← live staging mov (×3)
mul   x0, x27, x0
mov   x13, x0
umulh x0, x27, x12
mov   x14, x0
adds  x12, x13, x28
cinc  x28, x14, hs
ldr   x3, [x29, #336]     ← induction read again for the store index
add   x10, x16, x3        ← index add (clang: pre-scaled displacement)
str   x12, [x9, x10, #3]
add   x1, x29, #336       ┐ update = full slot round-trip:
ldr   x1, [x29, #336]     │  address materialized twice, load,
add   x0, x1, #1          │  add, store
add   x1, x29, #336       │
str   x0, [x29, #336]     ┘
```

### The five structural causes (pidigits)

1. **Loop inductions are frame-slot-resident.** 6 of our ~21 instructions
   are just `pi`'s slot traffic. Clang keeps it in a register. Our asm-level
   promotion has 2 promo registers and the NIR allocator's read-bars exclude
   these names — so every hot loop still pays this.
2. **No strength reduction to pointer-walking.** Clang walks pointers and
   pre-scales offsets once; we re-derive `[base + reg<<3]` every access.
3. **Live staging moves.** Our fixed accessor protocol (`mov x12, x0` ×3) —
   clang's regalloc places values where they're consumed, so it never emits
   them.
4. **Real calls + ABI marshaling.** The sampler shows **282 samples in
   `BigInt_ensure`** — called per D2 iteration with arg staging and spills.
   Clang inlined `ensure`/`grow` into `div_to` (its profile shows everything
   inlined into `main`; `clear` became `__bzero`).
5. **No unrolling/scheduling**, and more fundamentally: our optimizer is a
   constellation of shape-matching passes over text/AST with hand-proved
   gates; clang is an integrated SSA pipeline applying LICM + strength
   reduction + regalloc + unrolling **everywhere at once**.

### Sampler confirmation (pidigits n=12000)

Our hot time is SPREAD across ~8 loops: mul_to's small-b loop (.end_28,
748 samples), the D2 main loop (643), the D1-shift loops (412),
`BigInt_ensure` as a real call (282), D4-mi (235), D4-si2 (136), D3 (198).
The C profile: everything inlined into `main`, same algorithmic loops, at
~⅔ the sample counts. Winning 2 instructions in one loop moves the total
by ~1%.

## Part 2 — the spectral-norm evidence (new receipts)

Spectral-norm amplifies the gap to **2.25×** (0.18 vs 0.08 at n=1500), and
its profile is total: **100% of samples in `.while_4`** — the `j` loop of
`eval_a_times_u`:

```
a = a + (1.0 / (denom as float)) * u.load_float(j)
if transpose { denom += i + j + 2 } else { denom += i + j + 1 }
```

Per-iteration cycle math (45M inner iterations at n=1500, ~3.2 GHz):
**ours ≈ 12.8 cycles/iter; clang ≈ 5.7 cycles/iter.** Clang is running at
the fdiv throughput floor — the double-precision divide is this
algorithm's hardware limit; it did NOT vectorize or unroll (scalar fdiv
makes that unprofitable, correctly). We are 2.2× over that floor purely on
loop-body overhead: ours is 27 instructions where the essential work is 5
(`ucvtf, fdiv, fmul, fadd, ldr` — identical in both).

clang's 9-instruction loop body:

```
ucvtf d2, x14           ; (double)denom
ldr   d3, [x16], #8     ; u[j] — POST-INDEX pointer walk
fdiv  d2, d0, d2        ; d0 = 1.0 — fmov IMMEDIATE, materialized ONCE
fmul  d2, d2, d3
fadd  d1, d1, d2        ; accumulator never touches memory
add   x14, x15, x14     ; denom step — transpose constant BAKED IN
add   x15, x15, #1
subs  x17, x17, #1
b.ne
```

Our 27-instruction body adds four taxes the pidigits list didn't isolate:

6. **Loop-invariant branches are not if-converted.** `if transpose` sits
   INSIDE the j-loop (`cmp x12, #0; beq else_8`), with both arms in the
   body. Clang converts it before the loop (`cinc`/`csinc` — the transpose
   constant is baked into two registers; the branch is gone). Loop
   versioning/if-conversion is the single biggest missing transform here.
7. **Push/pop slot staging pairs inside the loop** (`str x1, [sp,#-16]!` /
   `ldr x1, [sp], #16`, ×2 paths) — stack_var's address-form emission
   fired even though the value was already in a register.
8. **Memory-materialized constants.** `adr x3, _float_op_4; ldr d18, [x3]`
   every iteration for the literal `1.0` — vs clang's `fmov d0, #1.0`
   hoisted once. No constant rematerialization pass exists.
9. **Per-iteration receiver re-derivation** (`mov x9, x20; ldr x9, [x9,#8]`
   - dead staging = 4 instrs): the buffer pipeline/pin machinery did NOT
     fire in this function — every pipeline register (x23–x28) was
     function-wide-claimed, and the pins/pipeline don't draw from the x4–x8
     scratch pool that tranche 5 opened. A ref-param receiver (`u`) in a
     top-level generic function is exactly the starved shape.

And one REFINEMENT to the pidigits list: this loop's inductions ARE
register-resident (x23/x24/x25 — `eval_a_times_u` cleared the read bars),
so cause 1 is not universal — the gap persisted at 2.25× WITHOUT
slot-resident inductions. The constant factors (6–9) are enough.

## Merged causal ranking (evidence-weighted)

1. **Loop-invariant branches not if-converted** — dominant in
   spectral-norm (a whole branch + both arms inside the hot loop);
   present in pidigits' D4/D5 (`if prod < lo_prod`) as flag-form work.
2. **Frame-slot staging for values already in registers** — the push/pop
   pairs (spectral-norm) and the slot-resident inductions (pidigits' `pi`:
   6 memory ops/iteration).
3. **Per-iteration receiver derivation / no pipeline hoist under register
   pressure** — 4 instrs/iter in spectral-norm; fixed in pidigits' D4 by
   tranches 5–6 but only where pool pins were available.
4. **Memory-materialized constants, no rematerialization** — `1.0` from
   memory per iteration.
5. **No pointer-walking strength reduction** — clang post-index walks;
   we index. (Our base-fold is the first step; the walked form kills the
   remaining index register entirely.)
6. **Real calls for small methods (`ensure`/`grow`/`clear`)** + ABI
   marshaling — 282 samples in pidigits.
7. **No unrolling / no scheduling** — clang unrolls copy loops ×2 with
   tail handling; we never do.

## Why the ASM_PLAN_5/6 tranches stopped paying

- The D4 loops went 25 → 12 instructions, but pidigits stayed at 0.50:
  (a) hot time is spread across ~8 loops, so 2 instructions in one loop is
  ~1% of the program; (b) the loops are latency/traffic-bound — removed
  ALU ops were overlapping L1 loads and the fdiv/mul chains.
- The tax that remains is exactly causes 1–6, which the tranches never
  touched: they removed instructions AROUND the accessor protocol, not the
  slot-resident state, the branches, or the call boundary.

## Tranches

1. **If-conversion / loop-invariant branch lifting in region brackets**
   (spectral-norm's biggest tax): a loop-invariant `if` whose arms only
   assign constants/differ by one operand lowers to `csel`/`cinc` before
   the header, or loop-versioning on the predicate. The region machinery
   already proves loop-invariance for pins — reuse it for control.
2. **Registerize loop inductions in region brackets** (pidigits' biggest
   tax): the induction is loop-proved write-in-latch/read-everywhere —
   pin it like a receiver (entry load, exit store-back, `region_pinned`).
   The pidigits `pi` loop's 6 slot ops become zero.
3. **Scratch-pool pipeline hoists** (spectral-norm receipt): when the
   x23–x28 pipeline pool is exhausted, draw receiver data-pointer hoists
   from NIR_SCRATCH_X under the same scan verdict — kills the 4-instr
   per-iteration re-derivation in register-starved functions.
4. **Constant rematerialization**: float/int literals loaded from
   `_float_const_N` pools inside loops become `fmov` immediates hoisted
   to the preheader.
5. **Stack-staging elision**: the push/pop pairs around computed indexes
   (`str x1,[sp,#-16]!` / `ldr x1,[sp],#16`) — when the value is already
   register-resident, skip the stack round-trip.
6. **Pointer-walk strength reduction** in brackets: `walk += 8` per
   iteration with unscaled `ldr [walk]` (clang's exact form; base-fold is
   the precursor).
7. **Auto-inline small methods** (`ensure`/`grow`/`clear`-shaped bodies ≤
   N statements): kills the call + ABI marshal per D2 iteration
   (282 samples in pidigits).
8. **×2 unrolling in validated cycles** (the asm-loop-promote model
   already validates cycle shape).

Verification discipline unchanged: kill-switch A/B byte-identity (off
arm), full suite green default-ON, bench matrix byte-identical across
backends, interleaved best-of timing — and now a per-tranche CYCLE CENSUS
against the clang disassembly of the same loop (the benchmark here).

### Tranche 2 (2026-09-08): loop-induction pins — LANDED

The plan computes per-loop induction candidates (written in the region +
live into the header + cross-boundary life + traffic bar, plain
uniquely-declared non-float scalars only) and assigns leftover scratch
registers on both the pool path (after pins/folds) and the scratch path;
the bracket entry-loads, binds, and store-backs with emit-time fallback
across x4–x8 (a nested bracket holding the planned reg falls back, never
miscompiles). The D3 `pi` loop goes 21 → 17 instructions/iteration with
**zero** in-loop slot ops (`cmp x7, x23`, bare-induction
`ldr x0, [x9, x7, lsl #3]`, latch `add x7, x7, #1`); the dead exit
store-back is elided by frame-slot forwarding.

One soundness receipt caught landing it: scratch registers die on ANY
call, but struct operator calls (`s + "ab"` → `bl string_add`) and
scope-exit destruction are invisible to the refuse gate and scratch scan
— the first cut hung `string_concat` (suite-caught, both failing tests).
Induction pins now require a heap-freedom proof (no `operator_func` op,
no string-typed traffic, no non-scalar in-region declare, no foreign heap
write); receiver pins keep their pre-existing gates.

Result: full suite green default-ON (298 files / 2906 tests) with
`test/induction_pin.test.ts` (shape, kill-switch, call/string refusals,
behavioral both backends); new `test/bench_matrix.test.ts` holds 13 bench
programs byte-identical across backends; pidigits n=4000 interleaved
best-of 0.78 → **0.76 s** with byte-identical digits, spectral-norm and
fannkuch neutral within noise. Remaining gap to clang's 9-instruction loop
is causes 2–7 (derivation, staging movs, no unroll) — tranches 3–8.

### Tranche 3 (2026-09-09): scratch-pool receiver hoists — LANDED

The plan now publishes each loop's scratch-scan verdict (`scratch_ok`) on
its region entry; when `pin_borrowable` refuses a planned pool pin at
emission time — the plan cannot see open brackets, so the enclosing
loop's pin on the same register is invisible to it — the bracket draws
the receiver hoist from NIR_SCRATCH_X under that verdict instead (same
emit-time-fallback discipline the tranche-2 inductions use, with the
same soundness spine: no displaced spills, no claim bits, `region_pinned`
refcount released at exit, fold registers pre-reserved so a fallback
never collides with a fold preload). Kill-switch:
`set_scratch_hoist_enabled(false)` — the off arm is byte-identical to the
pre-tranche build.

The spectral-norm receipt, concretely: `eval_a_times_u`'s j-loop planned
x27 (the function-wide occupant is dead in the j-loop), but the i-loop's
open bracket held x27 for `u.data`, so the pin died and the body paid
`mov x9, x20; ldr x9, [x9, #8]` every iteration. After the fallback the
derivation rides the preheader (`mov x8, x9`) and the body indexes
`ldr d0, [x8, x24, lsl #3]` directly — 2 of ~26 in-loop instructions
gone, and with them the per-iteration receiver re-derivation (cause 9 /
cause 3's starved shape).

Result: full suite green default-ON (301 files / 2937 tests) with
`test/scratch_hoist.test.ts` (shape, kill-switch off-arm byte-identity,
real-call refusal, behavioral both backends); bench matrix
byte-identical; spectral-norm n=4000 interleaved best-of 1.28 → **1.25 s**
(n=1500 unchanged at the 0.18 s fdiv-latency floor), pidigits n=4000 and
fannkuch n=11 neutral. Remaining gap to clang is causes 1–2 (partly
addressed by tranche 1) and 4–8 — tranches 4–8.

### Tranche 4 (2026-09-13): constant rematerialization — LANDED

The `adr x3, _float_op_4; ldr d18, [x3]` pair (cause 4) collapses to
`fmov d18, #imm` when three gates hold: the label is one of the
compiler's constant pools (`_float_op_N` / `_float_const_N` /
`_float_lit_N` — a top-level `var float f` ALSO emits a `.double` line
named after the variable, and collapsing its loads would freeze it),
the value is in the FP modified-immediate set (±m/16 × 2^e, m ∈
[16,31], e ∈ [-3,4], plus +0 — 3.14, exponents and −0.0 keep the pool),
and exact CFG liveness over the rewritten text proves the staging
register dead in both register views before the inserted fmov. The
liveness verdict runs its own backward fixpoint with one refinement
over the shared analysis: a call's ABI argument reads (x0–x8) do not
observe the candidates' staging registers — every argument a callee
actually reads is written at the call site, so the deleted pool
address cannot leak through an unused arg slot (without this, every
loop feeding a call refused: all eight arg slots model as live). Then
an in-cycle `fmov dX, #imm` whose destination appears nowhere outside
the cycle hoists to the preheader under a fresh caller-saved
d-register (d16–d31, textually absent in EVERY form — d/s/q/v share
the physical file, so a `v18.2d` NEON use hides d18) with the in-scope
reads renamed; the scope ends at the next dX definition, which is what
makes the three-operand consume-and-redefine shape (`fdiv d17, d17,
d0` reading the constant into its own destination) work — a label
between the fmov and the scope end refuses (a skipping path would
have dX hold something else; dM always holds the constant). Finally
`ldr xN, =K` in movz/movn range becomes `mov xN, #K`. The lift gained
the `fmov d, #imm` shape and float-immediate operand parsing; the
validator then covers every new emission.

Two suite-caught receipts while landing: (a) the collapse trial kept
the pair's `ldr` (a `continue` that skipped nothing), so every verdict
saw the address still read and the pass silently never fired — the
kill-switch A/B test caught it only after the first synthetic test
passed; (b) the first rename mapped textual match ordinals onto
ABSOLUTE operand positions (`fmul d16, d8, d17`'s single d17 match is
operand 2, ordinal 0) — the rename became a no-op, the hoist deleted
the only def, and four behavioral tests ran with undefined d-registers
(f=0.0, -0.000000, an infinite fcmp loop). Both fixes are shape-local;
the guard-rail tests pin them.

Result: full suite green default-ON (341 files / 3161 tests) with
`test/const_remat.test.ts` (collapse + hoist shape, consume-and-
redefine rename exactness, kill-switch byte-identity, non-encodable /
variable-label / escaping-address / label-split-scope refusals,
movz-range int remat, behavioral both backends). The spectral-norm
j-loop's per-iteration `adr+ldr` pair is gone (the `1.0` rides the
preheader); pidigits' D-loops lose their pool loads the same way.

### Tranche 5 (2026-09-13): stack-staging elision — LANDED

The push/pop staging pairs around computed indexes (cause 2's second
half, cause 7) elide in two forms. FORM B — `str xS, [sp, #-16]!` …
clean middle … `ldr xS, [sp], #16`, where the middle is linear (no
labels, branches, calls), touches neither sp nor xS in EITHER register
view, and may be empty of everything but index arithmetic — is a
SEMANTIC IDENTITY (the pop restores exactly the pushed value; sp nets
zero) and deletes unconditionally. This is the shape the slot-resident
accumulator actually produces (`add x1, x29, #32; ldr x1, [x29, #32]`
staged across the step computation) and it needs no verdict at all.
FORM A — the staging `mov xS, xV` in front — additionally deletes the
mov and renames the consumer's read of xS to xV, gated on: xV never
redefined between mov and consumer (w-siblings share the register —
the `ldrb w0` after `mov x1, x0` is an x0 redefinition), and exact CFG
liveness over the rewritten text proving xS dead after the consumer
(the same machinery tranche 4 built: call-arg slots and the return
pair x0/x1/d0/d1 read only when actually written — an unwritten slot
is garbage nobody observes; without the exclusion the x1 propagation
from a distant `ret` refused everything).

Two suite-caught receipts while landing: (a) the first w-sibling miss —
`ldrb w0` after a `mov x1, x0` staging slipped the xV-def check, the
rename produced `cmp x0, x0` and six regex tests matched everything
(character classes compared a register with itself); siblings now
share fate in both the middle scan and the def checks. (b) The
verdict's line index in the combined trial must subtract the
candidate's OWN three deleted lines, not just its siblings' — without
it `line_block[f]` read past the analysis and crashed. Landing also
split the liveness analysis per FUNCTION chunk (the same ret/.data
boundary heuristic the lift uses — control flow cannot cross a ret),
cutting the tranche's build-time cost on pidigits from ~370 ms to
~115 ms; the corpus byte-identity test had been timing out under full
parallel load before the split.

Result: full suite green default-ON (343 files / 3172 tests) with
`test/staging_elide.test.ts` (both forms' shape, call/label/touch
refusals, the w-sibling receipt, rename refusals with the pair still
eliding, kill-switch byte-identity, real-build pick-function scoping,
behavioral both backends). The pick receipt: both arms' staging pairs
per iteration gone; the spectral-norm `if transpose` arms lose their
×2 push/pop tax.

### Tranche 6 (2026-09-13): pointer-walk strength reduction — LANDED

The walked form (cause 5) is the POST-INDEX one — clang's receipt
fuses the bump into the memory op (`ldr d3, [x16], #8`), so a
latch-side `add w, w, #stride` would buy nothing; the walk is worth
taking only when the fusion is free. Inside a validated cycle, a
(base, induction, scale) access group with EXACTLY ONE in-cycle
access, no jump-targeted label anywhere in the body (an inner diamond
would make the access conditional — the post-index bump would skip on
some iterations and desync from the induction; the loop-exit guard
targets OUTSIDE the range and pairs correctly), an induction defined
exactly once by `add j, j, #m` in the latch, a base defined nowhere in
the cycle, and a shared scale rewrites to: preheader
`add w, base, j, lsl #k` (j's entry value IS the value at the
fall-through preheader — single-entry cycles), and the access becomes
`… [w], #(m·2^k)`. The walk register comes from the if-conversion
scratch pair (x16/x17) but must be textually absent from the ENTIRE
function chunk — absent-from-body is not enough, since an ENCLOSING
loop's if-converted select can live across this cycle in a register
the body never mentions, and the preheader/latch writes would clobber
it. Vector (q/v) accesses belong to the NEON planner's closed-form
loops and are never walked. The composition with tranches 2/3 is the
plan's intent: the bracket-pinned receiver's single scaled access
becomes `u.data + j·8` materialized once, then `ldr [w], #8` — one
scratch-hoist test assertion updated to the composed (walked) shape;
the store indexing the OUTER induction stays indexed (invariant in
this cycle — refused, correctly).

Result: full suite green default-ON (344 files / 3181 tests) with
`test/pointer_walk.test.ts` (post-index shape, stride-tracking with
j += 2, multi-access / inner-diamond / extra-induction-def / base-def
refusals, function-wide walk-register absence, kill-switch
byte-identity, behavioral both backends).

### Tranche 7 (2026-09-13): auto-inline small methods — LANDED DEFAULT-OFF

The mechanism is in and proven on the receipt shape; the switch ships
OFF pending one root-cause. `is_auto_inline_method` admits unmarked
methods with ≤3 statements, ≤3 params, scalar-or-void returns, no raw
statements / moved params / param shadowing, and a STRUCT receiver
(string self is a fat (ptr,len) pair the splice parks half of — the
at_or receipt; scalar receivers like `char.is_digit` are no struct at
all). The widened dispatch reuses the user-inline splice wholesale,
plus a splice-active guard: a nested call to the method currently
being spliced (recursion) takes the `bl` instead of re-splicing
forever. The standalone body is still emitted — trait dispatch,
method values, and overflow-arg call sites keep taking the `bl`.

Suite-caught receipts while shaping the predicate: string-receiver
splices return garbage bounds (`at_or` reading a half-parked self),
7-param splices fall back to global-address emission for their params
(`set_leaf_kind`), and — the blocker — EVERY spliced `JsonTree`
method segfaults independently (`set_kind`/`get_child`/`reset`/…,
each excluded alone leaves the crash): their bodies nest a GENERIC
user-inline (`Buffer<T>.load_T`/`store_T`) constructing a struct
local inside the auto splice, a composition the user-inline surface
never exercised. The mechanism ships kill-switch-only (default OFF —
byte-identical to pre-tranche) with the investigation recorded in
FOLLOWUP.md; the ON arm is proven by `test/auto_method_inline.test.ts`
(splice-instead-of-bl shape, standalone body still emitted, default-OFF
pin, recursive-method bl fallback, behavioral both backends).

### Tranche 8 (2026-09-13): ×2 unrolling in validated cycles — LANDED

The asm-loop-promote cycle shape, unrolled without increment
rewriting: the header label moves below a PRE-GUARD copy (the
original guard text, evaluated at the same sequential point — zero
increments before it), the body duplicates with a second guard copy
before the back-edge. Every guard instance is the original text at
the same sequential position; both copies keep their own `j += m`,
so j's final value and every body execution are bit-identical for
trip counts 0, 1, odd, and even (proven by an emulator test over
n = 0..5 and behaviorally on both backends). Validation: the while-
dispatch guard shape (`cmp` + `b.cond exit` targeting outside the
cycle), no calls/indirect exits, no jump-targeted inner label (an
inner diamond would duplicate its labels and let copy-2 skip copy-1's
increments); untargeted markers (`.while_update_N:`) drop from the
duplicate — duplicate label definitions are assembler errors, and a
marker positions nothing. Per-iteration guard overhead amortizes 2 →
1.5 instructions (3 guards per 2 iterations). Runs AFTER pointer-walk,
so both copies carry every earlier transform; the lift re-validates
the rewritten text and any failure reverts the candidate.

Result: full suite green with `test/unroll2.test.ts` (duplication
shape, label placement, call/diamond/size refusals, kill-switch
byte-identity, behavioral trip-count exactness both backends). Note:
the emit_nir benchmark-corpus byte-identity test has grown marginal
against its 30 s budget on this machine after hours of continuous
runs — it times out identically at the pre-tranche-8 HEAD (verified
via stash), so the flakiness is environmental, not this diff.
