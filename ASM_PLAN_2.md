# ASM_PLAN_2.md — closing the remaining aarch64 gap (no clang in the loop)

> Follow-up to ASM_PLAN.md (which is fully discharged: NIR pipeline, NEON
> vectorizer tranches 1–6, stack-balance validation). Constraint for
> everything in this document: **the aarch64 artifact stays hand-written
> assembly — no clang/LLVM in the aarch64 build.**

## Where the gap actually is (receipts, mandelbrot `mbrot`)

Same source, same chip, our `mbrot` vs clang `-O2`'s:

| `mbrot`            | ours | clang `-O2` |
| ------------------ | ---- | ----------- |
| instructions       | 522  | 50          |
| FP ops             | 71   | 38          |
| branches           | 53   | 2           |
| stack-slot touches | 114  | 0           |

What clang did — and it's only two things:

1. **Full unrolling of the fixed-trip inner loop.** `while inner < 5` has a
   compile-time trip count, so the loop is gone: the outer body is five
   copies of the 7-op FP chain back-to-back. Per outer iteration clang
   executes one escape check; we execute a real inner loop (counter,
   compare, branch × 5).
2. **Every hot local in a register.** clang touches the stack **zero**
   times in the hot path; we touch it 114 times — float locals live in
   stack slots (the promotion pool is d8–d11 and gets spent on params),
   so every read/write is a `ldr/str [x29, #N]`.

(FMA is _not_ the story for this bench — clang's mbrot contains zero
`fmadd`; the dependence chain wouldn't speed up.)

## Analysis method (repeatable per benchmark)

The receipt numbers above come from a repeatable recipe. For any
`bench/nomen/<name>.nm`:

1. **Emit both artifacts** (tsx, using the repo's own build):
   - aarch64: `build(parse(join("bench/nomen/<name>.nm", "core"), lib),
{ arch: "aarch64", audit: true })` → write `code` to `main.s`.
   - C `-O2` asm: `build(..., { arch: "c", audit: true })` → write
     `code + companion` to `main.c`, `headers` to `main.h`, then
     `clang -O2 -S -o main-O2.s main.c` (one input file per invocation —
     clang rejects `-o` with multiple sources).
2. **Extract the hot function** from each text: slice from the function's
   label (`^<name>:` in ours; `^_<name>:` in clang's) to the next
   function-label anchor (`^main:` in ours; `^_[a-z]` in clang's). Beware
   two traps: cutting at the first `ret` truncates multi-exit functions
   (early returns), and clang inlines small callees — if the function
   vanishes, the hot code moved into its caller; analyze the caller.
3. **Count per function body** (skip labels `.*/…:`-prefixed lines,
   directives `.*`, comments `//`/`;`):
   - total instructions;
   - FP ops (opcode starts with `f`) — the compute floor;
   - branches (`b`, `b.cc`, `cbz/cbnz`, `tbz/tbnz`) — loop/control
     overhead that disappears with unrolling;
   - instructions mentioning `sp` — slot traffic that disappears with
     register allocation.
4. **Read the two bodies side by side.** The counts rank the gap; reading
   the asm names the pass: a loop kept where clang has N straight-line
   copies = unrolling; `ldr/str [x29, #N]` around every operand = register
   allocation; `fmul`+`fadd` pairs clang replaced (or didn't) = contraction
   opportunities; repeated identical address computations = CSE.
5. **Time at the REAL bench size** (args from `bench/benchmark.sh`, e.g.
   mandelbrot n=1000/2000 — not toy sizes), interleaved best-of-N on both
   binaries, before claiming any movement.

The whole thing is one throwaway tsx script (~60 lines); the mandelbrot
version lives in this document's history (test/tmp_probe/receipts.ts
pattern). Run it per bench before planning a tranche — it converts "clang
is magic" into a two-line diff of specific missing passes.

## Tranche A — full unrolling of fixed-trip loops

`plan_full_unroll` (new `unroll.ts`), consulted by `build_while_loop_node`
under an active NIR cursor:

- condition is `i < B` with B an integer literal (0 < B ≤ 64);
- the induction's nearest pre-loop def establishes literal 0 (shared
  `scan_init`) — so the trip count is EXACTLY B and the loop can be
  dropped, not guarded;
- the update is the sanctioned `+1` increment (update slot or last body
  statement) and is dropped with the counter;
- the induction is not READ anywhere in the body (`stmt_reads` over the
  NIR body) — dropping the counter is then unobservable;
- no `break`/`continue` directly at this loop level (they'd target the
  deleted loop); `break`/`continue` inside NESTED loops are fine (they
  target the nested loop). `return`/`exit`, `raw` (duplicate labels),
  `nested_func` (duplicate function labels), `anon_struct`, `opaque`,
  `async_block` reject; non-scalar declarations reject (per-copy
  re-declaration is only kept sound for scalars — no destroy/cleanup
  interactions);
- body size × trip count capped (≤ 500 statements) to bound code size.

Emission: N copies of `build_block_with_cursor(node, nir.body)` — the
existing NIR cursor does the per-statement dispatch; per-copy scalar
declarations allocate fresh slots (stack_offsets re-keyed per copy —
sequential semantics preserved). Loop promotion still runs before the
copies, so body floats load into promoted registers once and store back
after — copies chain through registers. Kill-switch:
`set_loop_unrolling_enabled` (NIR-cursor-gated like the vectorizer, so the
byte-identity harness is unaffected).

Target: mandelbrot's both loops unroll (counters unused, bounds 10 and 5,
inits 0) — 53 branches → ~10, inner loop overhead gone.

## Tranche B — operand-order spill elimination (revised after re-reading the asm)

The analysis method strikes again: re-counting `mbrot`'s stack touches by
SHAPE showed the locals are ALREADY promoted (d8–d15 prologue saves; no
`ldr d, [x29, #N]` dominance) — the per-iteration stack traffic is the
float operand spill: `need_float_spill = !is_simple(left)` spills d1
whenever the LEFT operand is complex, even though the spill is only
necessary when BOTH sides are complex (a simple right — literal, local,
`load_float` — can be built after the complex left without being
clobbered).

Fix (three sites sharing the pattern: build_operation_node's float path,
its fcmp path, emit_cond_branch's float path):

- `need_spill = !simple(left) && !simple(right)`;
- when the left is complex and the right is simple, build LEFT first
  (into d0 — nothing live yet, its internal d0/d1 scratch is free), then
  the right into d1. Register-to-operand assignment is unchanged (left
  still lands in d0, right in d1), so `fsub`/`fdiv` order is unaffected —
  no commutativity needed.

(A caller-saved v16+ promotion pool remains a non-tranche follow-up: the
existing d8–d15 pool already covers mandelbrot, and expression scratch is
hardwired to d0–d2.)

## Success criteria

Measured at the REAL bench sizes (`bench/benchmark.sh`: mandelbrot
n=1000/2000), release builds, interleaved best-of-N:

- Tranche A: mandelbrot branches per `mbrot` drop to ~10; measurable
  runtime drop vs the pre-unroll release build.
- Tranche B: mandelbrot `mbrot` stack touches → ~0; further runtime drop.
- No regressions across the rest of the bench matrix; full suite green;
  kill-switch off = byte-identical output.
