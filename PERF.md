# PERF.md — Release Optimizations

What `--release` (`nomen run|build --release`, `-r`, or `"release": true` in
the config file) does, which optimizations exist, whether they're
implemented, and what improvement (if any) they make. Measured numbers are
best-of-3 on Apple Silicon (AArch64), small benchmark workloads
(`bench/benchmark.sh` sizes), Aug 2026 — treat them as indicative, not exact.

The two backends need opposite treatment:

- **C backend** — the emitted C is compiled by clang, so optimizations come
  from clang itself: `--release` compiles with `-O2` (debug builds are
  clang's default `-O0`).
- **AArch64 backend** — the emitted `.s` is _assembled verbatim_; clang's
  optimizer never sees it. `--release` instead runs the compiler's own
  optimization pipeline over the assembly text
  (`src/build_common/optimize_asm.ts`). The companion C file (UI interop /
  async pool) is still real C and also gets `-O2`.

For the always-on codegen optimizations (buffer accessor inlining, float
round-trip elimination, register allocation, …) see
[`bench/IMPROVEMENTS.md`](bench/IMPROVEMENTS.md) — those apply to debug
builds too.

## Implemented

| Optimization                                                         | Backend | Status | Improvement                                                                                                                                               |
| -------------------------------------------------------------------- | ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clang -O2` on generated C (`--release`)                             | C       | ✅     | **2.1–12×** on the benchmark suite (table below); inlines the per-char accessors and string adapters that stay call chains at `-O0`                       |
| `clang -O2` on the companion C file (`--release`)                    | aarch64 | ✅     | Only affects programs whose hot path is companion C (async pool / UI); neutral on the current suite                                                       |
| Constant folding + propagation over whole-program asm                | aarch64 | ✅     | Neutral runtime; −0.3–3% code size. Folds monomorphized raw-asm width dispatches (`cmp #T_SIZE` + branch runs) the text backend can't otherwise see       |
| Dead-branch folding (never/always-taken `b.cond` on known constants) | aarch64 | ✅     | Neutral runtime; part of the size win above                                                                                                               |
| Strength reduction (`mul` by known power-of-two → `lsl`)             | aarch64 | ✅     | Neutral on the suite (hot-loop strides are already `lsl` from the always-on passes); removes the remaining strided `mul`s in library load_T/store_T tails |
| Unreachable-code elimination (after unconditional `b`/`ret`)         | aarch64 | ✅     | Size only; enables branch-to-next folds                                                                                                                   |
| Branch-to-next elimination (`b .Lx` directly before `.Lx:`)          | aarch64 | ✅     | Size only; cleans up the branches the folding passes create                                                                                               |
| Identity-move elimination (`mov xN, xN`, `fmov dN, dN`)              | aarch64 | ✅     | Size only                                                                                                                                                 |
| Constant folding of literal binops (`2 * 8`, `1 << 3`, …)            | both    | ✅     | Always-on (not release-gated) — see IMPROVEMENTS.md item 10                                                                                               |

The four aarch64 release passes iterate to a fixpoint; each is a
conservative text pass (no CFG) that also has to respect numeric local
labels (`1:` / `b.hs 1f` in raw `#arch: aarch64` blocks) and label+data
lines (`_str_1: .asciz "…"`).

### Why the aarch64 passes are perf-neutral (measured)

| Benchmark      | aarch64 debug | aarch64 release | C `-O0` | C `-O2` |
| -------------- | ------------: | --------------: | ------: | ------: |
| pidigits       |        116 ms |          116 ms |  219 ms |   18 ms |
| fannkuch-redux |        339 ms |          341 ms |  276 ms |  103 ms |
| binarytrees    |        163 ms |          163 ms |  146 ms |  121 ms |
| nsieve         |         65 ms |           66 ms |   74 ms |   35 ms |
| lru            |          9 ms |            9 ms |    9 ms |    6 ms |
| nbody          |        145 ms |          142 ms |   83 ms |   22 ms |
| spectral-norm  |         43 ms |           42 ms |   55 ms |   12 ms |
| mandelbrot     |        150 ms |          151 ms |  191 ms |   48 ms |
| edigits        |          5 ms |            5 ms |    6 ms |    4 ms |

The AArch64 codegen's _hot loops_ are already as tight as the always-on
passes make them — the release pipeline mostly cleans cold/library dispatch
code, so runtime is unchanged (within noise) and text shrinks slightly.
`-O2` on the C backend, by contrast, now beats the AArch64 backend on
float-heavy benchmarks (nbody 22 vs 142 ms, spectral-norm 12 vs 42 ms,
mandelbrot 48 vs 150 ms) for the same reason Rust/Zig beat it: clang
auto-vectorizes the float loops into NEON, which a text pass over scalar asm
cannot replicate. That SIMD/vectorization gap — not these cleanups — is the
remaining performance frontier for the aarch64 backend.

## Rejected (tried, unsound or no win)

| Optimization                                         | Backend | Why rejected                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adjacent `str xN,[addr]`/`ldr xN,[addr]` elimination | aarch64 | **Unsound.** Preserves register state but deletes the only _write_ to the slot; a later non-adjacent `ldr` of the same address (the spill/reload idiom in raw library asm, e.g. `int_to_string`) reads garbage. Needs stack-slot liveness, impossible in a text pass |
| `Buffer.data` pointer LICM                           | aarch64 | Sound when implemented, but A/B measured **no win** (L1-hit loads hidden by the OoO engine) and small regressions from per-loop bookkeeping — reverted. See IMPROVEMENTS.md "Known issues"                                                                           |
| Loop unrolling of small fixed-trip loops             | aarch64 | Not attempted as a text pass (needs trip-count analysis); done manually in benchmark sources where it matters (`mandelbrot` unroll-by-5)                                                                                                                             |

## Not implemented (future work)

| Optimization                                       | Backend | Expected win                                                                                          | Notes                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NEON auto-vectorization — elementwise + reductions | aarch64 | **Landed** (2026-08, IMPROVEMENTS.md items 33–36): −65% saxpy, −91% dot products                      | Unrolled `.2d`/`.4s` groups over NIR: f64, 8-byte int, uint32, range fors, MIN_TRIP threshold; float reductions under the explicit `--fast-math` opt-in, bit-exact integer reductions always on. Shifted indices + 64-bit int mul are the remaining tranches |
| d0–d7 float _params_                               | aarch64 | ~0 on the current suite (measured: no hot non-inlined float-param calls; `Math.sqrt` is naked-inline) | The d0 convention's other halves **landed** (2026-08: `fcmp` comparisons + d0 returns — see IMPROVEMENTS.md items 26–27). Params remain x-register raw bits; deferred because `function_param_regs` has broad blast radius for no measured win               |
| General LICM of loop-invariant array bases/bounds  | aarch64 | Small (OoO hides most of it — same finding as `Buffer.data` LICM)                                     | Needs dominance/alias info the text backend lacks                                                                                                                                                                                                            |
| Tighter `bl` cache invalidation (per-receiver)     | aarch64 | Small; re-enables within-loop field-cache hits                                                        | Currently any non-inlined call drops every field data-pointer cache entry                                                                                                                                                                                    |
| Faster allocator                                   | runtime | Large for binarytrees/merkletrees (allocation-dominated)                                              | Per-node malloc/free churn vs a slab/bump path                                                                                                                                                                                                               |

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
