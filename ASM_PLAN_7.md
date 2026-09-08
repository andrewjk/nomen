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
   + dead staging = 4 instrs): the buffer pipeline/pin machinery did NOT
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
