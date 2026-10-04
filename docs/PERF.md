# PERF.md — Release Optimizations

What `--release` (`nomen run|build|test --release`, `-r`, or `"release": true`
in the config file) does, which optimizations exist, and where the aarch64
backend's performance actually comes from. Measured numbers are best-of-3+
interleaved medians on Apple Silicon (AArch64) at `bench/benchmark.sh` sizes
(Oct 2026) — treat them as indicative, not exact. The living performance
record is [`docs/scratch/ASM_PLAN_7.md`](scratch/ASM_PLAN_7.md) (+ addenda) and
[`docs/ASM_TODO.md`](ASM_TODO.md); the per-item history is
[`bench/IMPROVEMENTS.md`](bench/IMPROVEMENTS.md).

The two backends need opposite treatment:

- **C backend** — the emitted C is compiled by clang, so optimizations come
  from clang itself: `--release` compiles with `-O2` (debug builds are
  clang's default `-O0`).
- **AArch64 backend** — the emitted `.s` is _assembled verbatim_; clang's
  optimizer never sees it. The backend's optimizer is the **always-on
  pipeline** that runs in every build (see below); `--release` only adds a
  small cleanup pass set (`src/build_common/optimize_asm.ts`) and `-O2` for
  the companion C file (UI interop / async pool).

## `--release` on aarch64 is a near-no-op by construction

The four release-gated text passes (constant folding + propagation, dead-
branch folding, strength reduction, unreachable-code / branch-to-next /
identity-move elimination — iterated to a fixpoint, numeric local labels and
label+data lines respected) produce a runtime-neutral, slightly smaller
text: on a 131k-line bench `.s` their entire diff is ~3.4k branch-to-next
deletions. Re-measured Oct 2026 (best-of-3, large sizes):

| Benchmark          | aarch64 debug | aarch64 release |
| ------------------ | ------------: | --------------: |
| pidigits 4000      |           504 |             510 |
| spectral-norm 1500 |            81 |              82 |
| nbody 5M           |           215 |             215 |

This is the documented posture, not an oversight: the heavy lifting
(inlining, register allocation, vectorization, loop transforms) lives in
the **always-on** passes below, which is also why debug builds are
representative for benchmarking.

## Where aarch64 performance comes from (always-on, debug == release)

The ASM_PLAN_2–7 arc landed an optimizer over the NIR and the final
assembly text, all default-on with kill-switches and byte-identical off
arms. Headlines (interleaved A/B vs the pre-tranche builds):

- **Method inlining** — user-`inline` splices, naked-inline raw bodies, and
  auto-inlining of small methods (leaf bodies, and since the frame-context
  fixes also call-bearing chains whose calls splice through or are
  `extern` — `ensure`→`grow_int` expands with zero hot-path `bl`s).
- **NEON auto-vectorization** — elementwise `.2d`/`.4s`/`.16b` groups over
  NIR (f64, 8-byte int, uint32, byte), shifted reads (`load(i + c)`, c ≥ 1,
  per-element event-order rule), range-fors, MIN_TRIP threshold,
  guard-free `while i < a.cap` bounds; float reductions under the explicit
  `--fast-math` opt-in, wrap-exact integer reductions always on.
  saxpy −65%, dot products 2× faster than C `-O2` (IMPROVEMENTS.md 33–37).
- **Register/slot machinery** — NIR site allocation with statement-level
  liveness, loop-carried slot promotion (read+write and read-only slots,
  carry-increment collapse to `cinc`), region-scoped pool pins, scratch/
  induction hoists for pool-exhausted loops, frame-slot forwarding +
  the store-store kill (an orphaned pending store whose slot's next block
  access is another store drops — the mul_to carry-flag residue,
  pidigits −1–2.4%).
- **Loop transforms** — if-conversion of loop-invariant diamonds, ×2
  unrolling of validated cycles, pointer-walk strength reduction,
  constant rematerialization, stack-staging elision.
- **Checker-verified bounds** — the flow-bounds machinery (shifted bounds,
  path-vs-path guard mirroring, transitive relaxation) is what lets the
  guard-free vector shapes discharge `i: i >= 0 && i < self.cap` at
  compile time.

Headline outcomes vs the arc's start: the spectral-norm gap to C `-O2`
(2.25×) is **closed** (−53%); knucleotide −26%, fannkuch −28% (loop-slot
era); nbody at parity (0.99×). The remaining named gaps: pidigits ~1.5×
(live accessor staging movs — register-pressure artifacts — and the
merge-resistant result-tracking diamond) and binarytrees/merkletrees
(allocation-dominated; see the runtime row below).

## Rejected (tried, unsound or no win)

| Optimization                                         | Backend | Why rejected                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adjacent `str xN,[addr]`/`ldr xN,[addr]` elimination | aarch64 | **Unsound.** Preserves register state but deletes the only _write_ to the slot; a later non-adjacent `ldr` of the same address (the spill/reload idiom in raw library asm, e.g. `int_to_string`) reads garbage. Needs stack-slot liveness, impossible in a text pass                                               |
| Function-scoped write-only-slot elimination          | aarch64 | **Unsound at text level.** "Never-loaded" slots have invisible consumers: extern adapters and helper frame conventions read caller frames at fixed low offsets — deleting `Console_write`'s never-loaded parks corrupts the output (ASM_PLAN_7 addendum 5). Only the block-local store-store form (above) is sound |
| `Buffer.data` pointer LICM                           | aarch64 | Sound when implemented, but A/B measured **no win** (L1-hit loads hidden by the OoO engine) and small regressions from per-loop bookkeeping — reverted. See IMPROVEMENTS.md "Known issues"                                                                                                                         |

## Not implemented (future work)

| Optimization                                       | Backend | Status / expected win                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEON auto-vectorization — elementwise + reductions | aarch64 | **Landed** (2026-08, IMPROVEMENTS.md 33–37; kinds completed 2026-10: shifted reads + byte `.16b`)                                                         | Unrolled `.2d`/`.4s`/`.16b` groups over NIR: f64, 8-byte int, uint32, byte, range fors, MIN_TRIP threshold, guard-free bounds; float reductions under `--fast-math`, integer reductions wrap-exact. Remaining: variable-shift reads need the checker's symbolic cancellation (ASM_TODO) |
| d0–d7 float _params_                               | aarch64 | ~0 on the current suite (measured: no hot non-inlined float-param calls; `Math.sqrt` is naked-inline)                                                     | The d0 convention's other halves **landed** (2026-08: `fcmp` comparisons + d0 returns). Params remain x-register raw bits; deferred because `function_param_regs` has broad blast radius for no measured win                                                                            |
| General LICM of loop-invariant array bases/bounds  | aarch64 | Effectively **superseded** — the NIR CFG/region machinery (region pins, scratch/induction hoists, derivation memoization) covers the shapes that mattered | Dominance/alias info beyond that stays out of the text passes                                                                                                                                                                                                                           |
| Tighter `bl` cache invalidation (per-receiver)     | aarch64 | Small; re-enables within-loop field-cache hits                                                                                                            | Currently any non-inlined call drops every field data-pointer cache entry                                                                                                                                                                                                               |
| Faster allocator                                   | runtime | Large for binarytrees/merkletrees (allocation-dominated)                                                                                                  | Per-node malloc/free churn vs a slab/bump path                                                                                                                                                                                                                                          |

## Reproducing

```sh
# full benchmark matrix (compile + run, all languages)
sh bench/benchmark.sh

# A/B a single benchmark (release toggle is the 6th arg)
tsx bench/compile_nomen.ts bench/nomen/mandelbrot.nm /tmp/m core aarch64 1
tsx bench/compile_nomen.ts bench/nomen/mandelbrot.nm /tmp/m core aarch64 0

# or via the CLI
nomen run --in bench/nomen/mandelbrot.nm --lib core --release
```
