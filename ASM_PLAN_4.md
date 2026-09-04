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

Latest receipts per plan (interleaved best-of-N medians, release builds,
outputs identical; see each plan's RESULT blocks):

| bench             | ours vs C `-O2` | status                                             |
| ----------------- | --------------: | -------------------------------------------------- |
| nbody 5M          |        ~1.5×    | **at target** (float-bits forwarding was the last) |
| pidigits n=4000   |        ~1.85×   | 1.5× criterion unmet; structural levers below      |
| mandelbrot        |        ~1.25×   | last ratio at PLAN_2 tranche C; neutral since      |
| spectral-norm     |        ~1.8×    | serial denom chain; post-D-tranche accounting      |
| fannkuch/binarytrees/nsieve | neutral-ish | profile flat, no dominant label             |

Success criterion (written in ASM_PLAN_3, still standing): pidigits and
nbody within **1.5×** of the C `-O2` artifact, **or a written structural
blocker per remaining multiple**. nbody has met it; pidigits owes either a
winning tranche or that written accounting.

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
   anchor (`^main:` ours; `^_[a-z]` clang's). Two traps: cutting at the
   first `ret` truncates multi-exit functions (early returns), and clang
   inlines small callees — if the function vanishes, the hot code moved
   into its caller; analyze the caller.
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

### 1. Field-pair SLP pass (nbody) — the D-step-2 conclusion

Clang's `advance` win is field-pair SLP within ONE struct body — `(x,y)`,
`(vx,vy)` as `.2d` lanes, `faddp` horizontal sums, q-load/q-store of
adjacent field pairs — NOT lanes-over-j (analyzed unprofitable for AoS:
gathers cost more than they save). It is a different pass class
(superword-level pattern matching over consecutive statements), on the
order of the NEON vectorizer itself.

Nomen-specific constraints to receipt-check first:

- The vt-prefix layout shifts pairs: (x,y) sits at #8/#16 — the Q-form LDR
  immediate needs multiples of 16, so the usable Nomen pairs are
  **(y,z)@16 and (vx,vy)@32**. Gate: a census showing the instruction-
  count delta (~35 vs ~55 per body) survives the layout.
- `fsqrt` stays scalar (clang's does too).
- nbody is AT ~1.5×; this pass is how it goes further, and the same pass
  class is what any AoS float kernel needs.

### 2. Cross-block / cross-iteration value numbering + register coalescing (pidigits)

The K/L/M-survey lever, named "one order larger than a tranche": the
current reuse windows are statement-list scoped (straight-line, taint-
killed at calls/branches/joins), while clang keeps ~10 live scalars in
registers across the whole loop body. Components:

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
- **Traffic flip**: count flow-arm / spawn-arg reads in `traffic.ts`
  (currently deliberate barrier parity for promotion-input stability;
  pinned by test). Measure before/after per the discipline; whitelisted
  pins live in `test/nir.test.ts`.
- **Float promotion pool in v16+**: effectively SUPERSEDED — the float
  expression-tree allocator now occupies v16–v31 for call-free trees; any
  new pool must disjointly split against it (the x10/x11 tree-vs-pin
  collision is the int-side precedent).
- **Cross-backend argument-evaluation-order divergence** (aarch64
  right-to-left vs C left-to-right): visible only through side-effecting
  sibling args the checker does not hoist. Either hoist (checker) or
  align the order (emitters); low priority, but document the choice.

### 5. Recorded bugs to verify-then-fix (source: plan docs; FOLLOWUP.md has been cleaned since some were recorded)

Status unknown → verify at HEAD before acting on any of these:

- Two-ref-arg Buffer call marshalling swaps arg0/arg1 for guarded-
  main-scope calls (ASM_PLAN_2, tranche D session).
- `promote_loop_locals` misclassifies float PARAMS into the int pool
  (empty-string type default) — wasted registers, slot-correct values
  (ASM_PLAN_2, stage 2 debug dump).
- `for v of <call>()` crashes the C backend when the returned array has
  no compile-time length (ASM_PLAN.md, C expression seam session).
- C backend: hoisted `_param_N` temp loses the `&` for `ref` args
  (ASM_PLAN_2, tranche H).
- `mov Box?` nullable class-field write through a method SIGTRAPs on
  aarch64 at baseline (shape isolated; ASM_PLAN_2, field-marshal part 2).
- Shadowed-local read after its scope diverges between backends
  (aarch64 `x=10` vs C `x=8`; `stack_offsets` is name-keyed) (ASM_PLAN.md).
- Split-build link gap for user programs monomorphizing `Buffer<uint32>`
  (`Buffer_uint32_init` references System-internal `uint32_to_string`
  not in system.o) (ASM_PLAN.md, NEON tranche 2).
- C backend assign-expression fallback gap (ASM_PLAN.md, C seam;
  FOLLOWUP.md no longer lists it — may have been fixed).
- **Confirmed still open**: `build_declaration_node` builds scalar
  initializers TWICE (first emission discarded) — wasted compile time and
  a hazard for any consumed-once emitter state around declares
  (FOLLOWUP.md; the J tranche's armed-map mis-fire was this bug biting).

### 6. Phase-3 leftover duplication candidates (refactor-only, no urgency)

From ASM_PLAN.md phase 3, still unextracted:

- `collect_allocations` walk (`emit_allocations.ts` both backends) — needs
  an options flag (C collects LetNode values for statement hoisting).
- Owning-Buffer element specialization decision (`has_string_fields` could
  move to `build_common/` alongside `destroy_analysis.ts`).

## If resuming

1. Run the census + sample receipts for whichever lever above you target
   (recipe above; script is throwaway, recreate it).
2. Confirm the receipts still hold at HEAD — several surveys went stale
   when an earlier tranche moved the profile (tranche E's premise died
   when B flattened the profile; K's when L landed).
3. Follow the tranche landing checklist. Write the RESULT block here or in
   a successor plan doc; keep the honest accounting, including neutral
   outcomes and reversions.
