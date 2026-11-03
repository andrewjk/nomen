# ALLOCATOR_PLAN.md — the allocator attempt (PERF_PLAN item 1)

**ATTEMPTED AND REJECTED (Nov 2026).** A complete, tested drop-in allocator
(`src/nomen_alloc.c` + a text-mapping seam) was built, landed, measured, and
reverted. **On performance cores it is neutral on every bench measured** —
binarytrees, merkletrees, json-serde, lru, nsieve, both backends — while the
booked target was "Large" on binarytrees/merkletrees. The entire
implementation is preserved on branch `allocator-eager` (see "Where the work
lives"). This document is the research record: what was built, what it
actually does, why it was reverted, and the measurement trap that produced
the false positive.

## The design (what was built)

A drop-in small-object allocator with libc semantics, reached through the
audit layer's existing allocator-spelling mapping seam (zero emitter churn):

- **Runtime** (`src/nomen_alloc.c`, ~280 lines C): one anonymous mmap
  reservation (default 8 GB, `NOMEN_ALLOC_RESERVE` env, `NOMEN_ALLOC=libc`
  kill switch), committed in 64 KB per-class slabs from an atomic bump; a
  static page map (one byte per 16 KB page → size class, release-store on
  commit / acquire-load on free) so `free` learns the class with zero
  per-block memory cost; 41 size classes (16-byte steps to 128 → 256-byte
  steps to 4096); `_Thread_local` freelist heads (alloc = pop, free = push);
  libc above 4 KB and for every fallback (reservation failed/exhausted,
  kill switch), with the zone-membership check always first so issued blocks
  never switch allocators. Alignment 16; no header; realloc = same-class
  return or alloc+copy+free.
- **Seam**: plain builds map the generated allocator spellings
  (`malloc(` → `nomen_alloc(`, `bl _malloc` → `bl _nomen_alloc`, …) in
  build.ts / postprocess.ts / compile_nomen.ts — the non-audit counterpart
  of `wrap_c_allocators`; audit builds keep the wrapper text but the
  `audit_runtime.c` ledger allocates through the runtime (per-class
  quarantine, drained at 2048, preserves the stale-free poison forensics).
  Every compile path (CLI run/build/test, check_output, bench matrix,
  deadlock drivers) links `nomen_alloc.o`, content-hash-named so it compiles
  once per output directory. Emitters untouched.
- **Tests**: `test/nomen_alloc.test.ts` (plain path, both backends: tree
  churn, growth across class boundaries, Map/Set churn, cross-thread
  alloc/free through the spawn pool, kill switch) + the 549-file audit
  suite green through the ledger. Suite-green, RSS-flat (35.4 MB
  binarytrees-18 peak, both sides), audit contract unchanged.

The full design rationale, seam inventory, scope cuts, and risk list are in
the preserved `docs/ALLOCATOR.md` on the same branch
(`git show allocator-eager:docs/ALLOCATOR.md`).

## The measurement story — the context artifact

The first receipts said binarytrees −22.9% / −30.9%, merkletrees −12.0% /
−29.4% (interleaved medians, byte-identical outputs, HEAD-worktree A/B) —
and they were **real measurements of a false conclusion**. The A/B ran
entirely inside an agent/background shell, and the same binaries measure
consistently slower there than in an interactive terminal on this fanless
MacBook Air M2 (Mac14,2):

- binarytrees HEAD build: 1.42s in the interactive terminal, 1.86–2.12s in
  the agent shell (varying with machine state over the day).
- binarytrees allocator build: 1.43s in the interactive terminal,
  1.43–1.69s in the agent shell — a much smaller spread.
- Zig tree bench: 1.00s interactive / 1.38–1.61s agent. Rust: 0.94s /
  1.29–1.63s.
- Go binarytrees: **1.78s in BOTH contexts** to the millisecond — the
  context-stable control row that exposed the whole artifact.

**What was verified and what was withdrawn.** The QoS mechanism was tested
with a probe (`pthread_get_qos_class_np`) and REFUTED: agent-shell processes
run at `USER_INTERACTIVE` — the _highest_ QoS class — so the initially
assumed "utility QoS → efficiency-core placement" story is wrong.
`taskpolicy` clamps still work downward (`-c background`: Zig tree 9.0s vs
1.4s), but the interactive-vs-agent gap is not a QoS placement effect.

**What the gap actually tracks (2026-11-03, evening probes).** A
pure-compute spin chain (zero memory) is context-EQUAL — 2.69–2.84s from
the agent shell vs 2.71–2.73s interactive — so compute throughput and
effective clock are the same in both contexts; efficiency-core placement
and frequency differences are ruled out. The gap lives specifically in
**memory-service-heavy user-mode allocation paths**: the Zig tree bench
(page-allocator churn) and the libc-malloc build run their _user-mode_ time
~50–60% higher in the agent shell (bt_zig: user 1.57–1.64s vs 0.99s; sys
0.03–0.04s — fault service is NOT kernel-heavy), while memory-reusing
workloads are context-stable (freelist build, Go's GC arena). The
agent-shell side of the gap is _stable_, not noisy: 40 timed samples of the
Zig tree bench over 17 minutes read 1.39–1.51s, unchanged through load
spikes of 7–11 from other desktop activity, with the interactive runs
seconds away reading 1.00–1.04s. Wall time in
the agent shell can additionally lose ~25% to descheduling (real 2.10s vs
user+sys 1.60s) when the desktop session is active. Mechanism unattributed
— candidates are per-process-tree memory-service policy (the `opencode
serve` login-item's task attributes) or placement during fault handling;
precise attribution needs `sudo powermetrics` + `vm_stat` sampling during
runs, unavailable non-interactively.

**Measurement rules that stand:** A/B from an interactive terminal; bracket
with a context-stable control row (a memory-reusing binary — the freelist
build or Go — matched across contexts; pure-compute and fault-heavy probes
both served as canaries); agent-shell absolute numbers are
non-representative specifically for allocation-heavy workloads, and even
ratios should be verified interactively when a change moves allocation
between an mmap-heavy path and a reuse path (exactly the mistake item 1's
first receipts made).

### P-core receipts (interactive terminal, interleaved best-of-3)

| Bench             | Backend |  HEAD | allocator | Δ          |
| ----------------- | ------- | ----: | --------: | ---------- |
| binarytrees 18    | aarch64 | 1.42s |     1.43s | flat       |
| binarytrees 18    | C       | 1.00s |    0.965s | −3.5%      |
| merkletrees 17    | aarch64 | 0.84s |     0.85s | flat       |
| json-serde 25000  | aarch64 | 0.19s |     0.19s | flat       |
| json-serde 25000  | C       | 0.06s |     0.06s | flat       |
| lru 1000 20000000 | aarch64 | 1.68s |     1.68s | flat       |
| lru 1000 20000000 | C       | 0.85s |     0.88s | +3% (weak) |
| nsieve 12         | aarch64 | 0.14s |     0.14s | flat       |
| nsieve 12         | C       | 0.12s |     0.13s | flat       |

(outputs byte-identical between every pair)

### The degraded-context numbers, for the record (agent-shell / loaded machine)

In the degraded agent-shell context (and under explicit `-c background`
clamping) the allocator genuinely wins big — binarytrees 1.86–2.12s →
1.43–1.69s, merkletrees 0.98s → 0.85s, and the same direction on the
Zig/Rust competitor benches. Real for CI workers, background jobs, and
anything spawn-from-service — and actively misleading as an interactive-run
receipt.

## Why rejected

PERF_PLAN item 1 was booked as "Large" for the interactive benchmark matrix,
and on P-cores it is neutral on every bench measured, with one borderline
+3% (lru C). The house rule is receipts-or-nothing. The deeper finding: with
allocation made cheap, binarytrees/merkletrees sit at a **pointer-chasing,
cache-latency floor** that neither libc nor a freelist can move — which is
also the pointer for any future attempt (item-level pooling, arena reuse, or
codegen work on the Box store/destroy walk are the only levers that can
move a latency-bound bench).

## Where the work lives + revive path

The entire implementation (runtime, seam, tests, bundling, the design-doc
draft) is pinned to branch **`allocator-eager`** (tip `0e5850df`, the
verified stash commit; all files verified present, including the untracked
ones). The stash entry itself has been dropped. To revive:

```sh
git checkout allocator-eager          # inspect/measure the full attempt
git merge allocator-eager             # or re-land onto main deliberately
```

If revived, re-land with THIS document's framing (degraded-context win,
P-core-neutral) — not the withdrawn "Large" receipts.

## What survives regardless

- The interactive-vs-agent measurement caveat (also recorded in PERF.md,
  "Reproducing", and FOLLOWUP.md): same-binary measurements differ ~25–40%
  between this machine's interactive terminal and agent-spawned shells, the
  penalty falls on clock/instruction-bound builds, and the mechanism is
  NOT QoS (verified: agent-shell QoS is USER_INTERACTIVE) — attribution
  needs `sudo powermetrics`. A/B from an interactive terminal or bracket
  with a context-stable control row.
- FOLLOWUP.md's note that `bench/go/nsieve.go` no longer builds (bitset dep,
  no go.mod) — found while re-running the matrix.
- The observation that binarytrees/merkletrees on P-cores already sit at
  Nomen/A 1.42s vs Go 1.78s (0.8×) and Zig 1.00s / Rust 0.92s (1.4×/1.5×):
  the remaining tree-bench gap to Zig/Rust is the Box store/destroy walk and
  call overhead — latency-bound codegen territory, not allocator territory.
