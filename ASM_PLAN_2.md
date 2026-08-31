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

**RESULT (measured, interleaved best-of-5, release builds, outputs
identical):** mandelbrot n=1000 839 → 534 ms (**−36%**); nbody 1M
2505 → 1694 ms (**−32%**); fannkuch 53 → 47 ms (−11%); pidigits 4684 →
4318 ms (−8%); spectral/nsieve/binarytrees neutral. The second half of
clang's mandelbrot advantage was never "registers vs slots" — the locals
were already promoted; it was the operand fmov round-trips through the
d0/d1 scratch pair, which direct-source selection deletes.

## Tranche C — destination hint for float assignments (DONE)

The remaining per-statement fmovs were RESULT WRITEBACKS: `zi = <expr>`
evaluated the root op into d0, crossed domains (`fmov x0, d0`), and moved
into the target's register — an FP↔INT domain crossing per statement
(~5 cycles each; mandelbrot does 12/iteration).

`status.float_dest_hint` (BuildStatus): the assignment fast path (target
already promoted to a d-register) sets the hint; the ROOT float operation
in `build_operation_node` (binary + FMA paths) consumes it and emits
directly into the target register. Consume-once at the root: cleared
before operand evaluation so nested sub-operations keep the scratch
discipline, and the target's OLD value stays readable until the final
fused instruction (which reads its sources before writing — aliasing the
target as a source is safe). Scratch-safety guard: the hint is never
d0–d2. Unconsumed (leaf/call/cast RHS) → the existing writeback path.

Measured (interleaved best-of-7 vs the pre-tranche emitters, outputs
identical): mandelbrot n=1000 144 → **58 ms (−60%)** — 3.2× faster than
the 186 ms release row that motivated this plan, now within ~25% of the
C `-O2` entry; nbody 259 → 178 ms (−31%); fannkuch −7%; spectral neutral
(its cost is the serial denom chain). mbrot (unrolled): 1455 instrs with
116 fmovs remaining (result writebacks for non-assignment consumers).

## Tranche C addendum — float expression-tree allocation (DONE)

The destination hint covered the ROOT writeback, but complex operands
still round-tripped through d0/d1 with both-complex spills. The float
expression compiler now allocates CALL-FREE expression trees into the
untouched d16–d31 pool (v16–v31's scalar view — verified unused across
the backend and System raw blocks): every interior result gets its own
tree register, promoted operands are read IN PLACE as instruction
sources (zero copies), and the root lands directly in the assignment
target's register. Gates: no calls/spawns in the tree (they clobber
v0–v31), ≤14 nodes (monotonic temp counter fits the pool), unsupported
shapes fall back cleanly. Tree emission is bit-exact — same ops, same
order, different registers.

`build_float_tree(node, dest, next, status)` returns the result register:
leaves materialize into `dest` via the existing `build_float_operand`
(promoted-reg fmov, slot ldr, literal pool load, inline Buffer accessor);
binaries allocate fresh temps for non-promoted sides and emit
`fop dest, lreg, rreg`. Wired into the assignment fast path ahead of the
destination-hint path.

mbrot (unrolled) census: 2798 → 1455 instructions, fmovs 1456 → 116.

## Tranche D — accumulator-aware loop promotion (DONE)

The spectral receipts showed the actual remaining tax: `var a = 0.0` —
the accumulator declared INSIDE the loop — reads once per TEXT
occurrence, so the reads ≥ 3 rule excluded it from promotion. Every
`a = a + …` then round-tripped through its stack slot and fell off the
register fast paths (assignment hint, expression trees are d-target
only). Clang promotes accumulators because it counts EXECUTIONS.

`promote_loop_locals` now collects assignment targets in the loop body
(`collect_assign_targets`) and qualifies variables written in the body
with reads ≥ 1 as accumulators. Aliasing-aware exclusions guard it:
ref params, heap strings, class aliases, ref class slots, heap arrays,
struct param slots stay excluded (a promoted alias breaks write-through
semantics — caught immediately by the ref-param and class-aliasing
tests).

**RESULT:** spectral-norm n=1000 160 → **82 ms (−49%)** — now within
1.8× of the C `-O2` row. Full suite green (2651 tests) including new
`test/accumulator_promotion.test.ts` (promotion shape + behavioral run).
Pre-existing bugs recorded in FOLLOWUP.md while testing: the malformed
`scvtf d0, d0` for `int-cast + float` adds, and the two-ref-arg Buffer
call marshalling swapping arg0/arg1 for guarded-main-scope calls.

## Tranche E — index-constant unrolling (DONE)

Tranche A rejected any loop whose body READS the induction (the counter
was deleted). But the common hot shape — `while j < 5; j += 1 {
body[...] = f(...at(j)...) }` with a literal bound and a 0-init/+1-step
induction — has a compile-time value for the induction on EVERY copy:
copy k executes with the induction == k. `status.induction_const`
(as name → literal map, consulted by build_value_node and build_operand
ahead of the promoted lookup) makes induction reads immediate loads in
each copy.

Gates (beyond tranche A's): the body never ASSIGNS the induction (the
constant would be wrong), and the body contains no nested loop —
unrolling the parent multiplies the nested loop's text; the clang shape
keeps the outer loop and unrolls the inner (mandelbrot now matches that
shape too — previously it fully unrolled both). After the copies, a
post-loop store sets the induction to the trip count (its exact had-run
value), keeping post-loop reads correct.

Known limit: nbody's inner loop initializes from `j = i + 1` — the init
is only constant when the OUTER induction is (i.e. after outer
unrolling, which the nested-loop gate now defers). Peeling or outer-
first composition is future work. (Addressed by the tranche E addendum
below.)

## Tranche D addendum — declare-slot pre-allocation (DONE)

Body-declared loop locals (`var a = 0.0`, `const float bj_x = …`) still
miss promotion: promote_loop_locals runs BEFORE the body builds, so their
stack slots don't exist yet and the `stack_offsets.get(name) === undefined`
gate skips them. The caller-saved d24–d31 extension pool + single-declare
eligibility landed (commit e784fda8); the while builder now passes its
`call_free` too (it was computed and discarded there), and nbody's advance
needed the declare-slot pre-allocation on top: `promote_loop_locals` walks
the body's declares at promotion time, `allocate_stack_space` upfront
(same size/alignment as the declare build uses), registers the offset, and
records name → size in `status.preallocated_decl_slots`. The declare build
(`declare_slot_offset`) reuses that exact slot when the size matches, so
the loop-entry load, every slot access, and the exit store-back share ONE
slot. The naive version that pre-allocated WITHOUT the declare-side reuse
left them pointing at a slot nothing else read or wrote — run-dependent
uninitialized-memory output (reverted in ecff2f39; this is the reuse half
that was missing). The pre-allocation sits after the dtype-scalar and
shadow gates, so a body declare shadowing an outer name is never
pre-allocated (its map entry would hijack the outer name's
stack_offsets mapping after the loop). `enter_scope_frame` already copies
stack_offsets per frame, so pre-allocated entries die with the loop scope.
The whole-function allocator still wins candidates with reads ≥ 4 first;
the loop pass catches exactly those it can't (e.g. nbody's `dx`, 3 reads).

**RESULT (measured, interleaved best-of-7, release builds, outputs
identical):** nbody 5M steps 0.87 → 0.81 s (−7%); `advance` census:
instructions 514 → 511, slot touches 80 → 70, FP ops 99 → 106 (slot
`ldr d` loads became register `fmov`s). mandelbrot, spectral-norm,
fannkuch, binarytrees, pidigits neutral. Full suite green (2656 tests)
including the new nbody-advance shape test (fails on pre-tranche code,
verified) and a per-iteration-semantics behavioral test in
test/accumulator_promotion.test.ts.

**Tranche A revision:** unrolling measured neutral on mandelbrot with the
spill fix in place (+8% without it — slot traffic multiplied per copy).
The kernel is a serial FP dependence chain; loop overhead was already
hidden by OoO execution. Default stays OFF; the pass is sound, tested,
and available for loop shapes where the body is NOT a dependence chain
(e.g. memcpy-style loops with independent iterations).

## Tranche E addendum — outer-first composition (DONE)

The known limit fell. The outer loop now unrolls in index-constant mode when
every nested `while` in its body plans under EVERY copy's hypothetical env
(`induction → init + k`): per copy the inner's init resolves (`j = i + 1` →
k+1), and the inner unrolls itself inside the copy with trips
`bound − (k+1)` — the last outer copy's inner trip is 0, which is legal
(zero copies plus the post-loop store). Supporting changes:

- `plan_full_unroll` returns `{init, trip, emitted}` instead of a bare trip
  count. The init is resolved by a compile-time constant walker over the
  init AST (integer literals and `+`/`-` over names in the ambient
  induction-constant map — the enclosing copy's map, passed in from
  `emit_stmt_from_nir` as `status.induction_const`). Non-zero literal inits
  (`var i = 2; while i < 5`) unroll too — the trip count is still exact.
- The size cap counts the COMPOSED emission (`emitted`: copies composed
  with nested unrolls' volume + the post-loop store), still ≤ 500 — nbody
  advance composes to ~206 statements.
- The builder seeds `status.induction_const` ON TOP of the ambient map
  (nested unrolls stack constants) and RESTORES it after (it used to
  clobber with a fresh map); the post-loop store leaves the induction at
  `init + trip`, its exact had-run value.
- Nested `for`s still reject the parent (the planner is while-specific),
  and any nested loop failing to plan under ANY copy rejects the parent —
  both stay loops, byte-identical to the pre-composition emission.

Drive-by soundness fix: the planner never checked the comparison op —
`while i > 5` with a 0-init would have unrolled into 5 copies of a loop
that never runs. `<` is now required (read off the AST OperationNode; NIR
binary exprs carry no op).

**RESULT (measured, interleaved best-of-7, release builds, outputs
identical):** nbody 5M steps 0.836 → 0.788 s (−6%); `advance` census:
loops 2 → 0, branches 4 → 0 (instrs 359 → 2330 — composition multiplies
text by design; `energy` likewise 2 → 0). Mandelbrot (both loops now
compose) neutral — serial FP chain, exactly the Tranche A revision's
finding. for-loop benches (spectral-norm, fannkuch, binarytrees, nsieve)
take unchanged paths. Full suite green (2661 tests) with new coverage:
composed shape + behavioral pair-sum run (incl. a zero-trip copy),
composition gates (non-constant inner init, inner break), the `<` op
gate, non-zero literal init, and the zero-trip post-loop store. Default
stays OFF — the pass remains opt-in via `set_loop_unrolling_enabled`.

## Tranche F — int-side register codegen: dest hints, trees, ext pool (pidigits, DONE)

Receipts (same method as above, pidigits n=4000, `sample` + per-label
bucketing): the runtime was ~60% `BigInt_div_to` (Knuth-D limb loops:
`.end_while_19` alone 42% of samples), ~20% `mul_to` schoolbook, ~15%
`add_to`. The per-limb asm showed the shape: the int side never got the
float tranches' treatment, so every limb op round-tripped stack slots
(`ldr [x29,#N]`/compute/`str [x29,#M]`, ~30–54 instructions per limb vs
clang's 8–10). The int promotion pool is structurally starved here: 4
params ride x19–x22, the whole-function pass caps at 4 x-regs, Buffer
caches claim the rest, and the D3/D4 temps (`vv`, `lo_prod`,
`hi_prod`) read 1–2× textually — below the reads≥3 bar and not
body-written, so neither promotion pass could take them.

Four compiler changes, each the int analog of a float tranche (the
library source stays plain — the compiler got smarter, not the code):

1. **Int destination hint** (tranche C analog): `status.int_dest_hint`;
   the assignment fast path (build_assignment_node) and declaration
   initializers (build_declaration_node) set it for promoted x-targets,
   and the ROOT int op in build_operation_node emits straight into the
   target register — no x0 + writeback mov. Callee-saved x23–x28 only
   (a call inside the RHS would clobber caller-saved regs before the
   root reads its sources), consume-once, same aliasing argument as the
   float hint.
2. **Int expression-tree allocation** (tranche C addendum analog):
   `build_int_tree` lands call-free pure int-op trees (`+ - * / << >>
& | ^`) with interior results in x10–x11, promoted operands read IN
   PLACE, root directly in the target. Pool discipline mirrors the
   float split (tree d16-23 vs promotion d24-31): tree temps x10-x11
   are live only within one statement; the emitters that touch x10/x11
   (write barriers, NEON preheader, trait dispatch) cannot appear
   inside such a tree, and every inline accessor body uses x0-x9 only.
3. **Caller-saved int extension pool** (tranche D addendum analog):
   `INT_CALLER_SAVED_EXT = x12–x15` for call-free loop bodies, claimed
   after the callee-saved pool, synced by the existing loop-exit
   store-backs (which sit after `end_label`, so break exits are
   covered). Gated off when a NEON plan rides (the vector loop's
   preheader/lanes use x10–x14). In call-free mode the promotion bar
   drops to reads≥1: entry loads and exit stores amortize across every
   iteration, so any once-read var is worth a register.
4. **Call-site self-marshal elision**: a raw-only inline method whose
   body never reads self (no x19; x0 only ever a write-destination —
   `mul_wide_hi`, `get_at`, `set_at`, `div128`) skips the call-site's
   `mov x0, x19` + `str x0, [sp], …` + restore triple.

Enabling pass: `tree_is_call_free` (status-aware call-free scan) —
inline METHODS whose raw aarch64 bodies contain no `bl`/`blr` count as
call-free (BigInt `mul_wide_hi` yes, `div128` → ___udivti3 correctly
no), so the Knuth-D inner loops qualify for the ext pool. Byte-identity
harness: the AST arm and NIR arm must reach the SAME call-free verdict,
so the no-NIR arm scans the AST statements (`node.statements`) —
verified by test/emit_nir.test.ts (caught the asymmetry on the first
run: the NIR arm promoted more vars → different prologue).

Two soundness bugs caught before they shipped: the first tree pool
(x12+) overlapped the ext pool and the allocator materialized an
operand INTO the live loop induction `i` (hang at n=2000; found by
sample, fixed by the disjoint-pool split above), and the byte-identity
asymmetry (found by the harness).

**RESULT (interleaved best-of-5/7, release builds, outputs
byte-identical on every size and every bench):** pidigits n=4000
1.66 → 1.27 s (**−24%**); n=2000 0.38 → 0.29 s; n=1000 90 → 60 ms.
Bench matrix unchanged (mandelbrot/nbody/spectral-norm/fannkuch/
binarytrees identical times; nsieve −10ms noise-level; all outputs
identical). Full suite green (2661 tests). The C backend shares none of
this machinery and is untouched.

**Remaining gap (the honest accounting):** pidigits now runs ~3.9×
behind C `-O2` (was 5.4×). The remaining distance is the structural
register-allocation chasm — our per-statement model (every value = slot
or ONE promoted register, no liveness, no cross-statement temps)
cannot express clang's ~10-instruction limb loop, which keeps ~10 live
scalars in registers across loop iterations at once. Closing it is its
own project (a real int register allocator on the NIR level); the flat
post-tranche profile (no dominant label — time smeared across every
limb loop) is the receipt that no single further fast path moves the
needle.

## Tranche G — int register allocation at the NIR level (NEXT)

Where Tranche F leaves us: pidigits n=4000 1.27 s vs C `-O2` 0.32 s
(~3.9×, was 5.4×), and the post-tranche profile is FLAT — time smeared
across every Knuth-D/schoolbook limb loop with no dominant label, so no
single fast path moves the needle any more. The structural cause: the
per-statement compilation model gives every value exactly one home (a
stack slot or a single promoted register), has no liveness analysis,
and cannot keep a value in a register across unrelated statements.
clang's ~10-instruction limb loop keeps ~10 live scalars in registers
simultaneously; our model caps at ~8 promoted registers total and
cannot reassign them per region.

Closing the gap means building a real int register allocator at the NIR
level: live ranges over the canonical IR, allocation into x0–x7/x9–x15
within call-free regions plus the callee-saved pool. Sized like the
whole NIR pipeline, not a tranche — but it is the only remaining lever
of consequence for int-heavy kernels.

## Success criteria

Written before the measurements; kept for the record — the per-tranche
RESULT blocks above are the authoritative accounting. What actually held:

- Method (unrevised): measure at the REAL bench sizes
  (`bench/benchmark.sh`: mandelbrot n=1000/2000), release builds,
  interleaved best-of-N, outputs identical.
- Tranche A: **revised.** Unrolling mandelbrot measured neutral (the
  kernel is a serial FP dependence chain; OoO execution already hid the
  loop overhead — and +8% before tranche B's spill fix). The pass ships
  sound and tested but DEFAULT-OFF, opt-in via
  `set_loop_unrolling_enabled`; it pays where iterations are independent
  or compose (nbody's `j = i + 1` double loop: −6%, tranche E addendum).
  Under the flag, mandelbrot now fully composes (0 loops/branches in
  `mbrot`) — the "branches → ~10" target above is obsolete.
- Tranche B: **mechanism revised, win delivered.** The locals were
  already promoted (d8–d15); the stack-touches framing was wrong — the
  actual tax was operand-order spills through d0/d1. Fixing that took
  mandelbrot −36%, nbody −32%.
- Standing invariants (unchanged): no regressions across the rest of the
  bench matrix; full suite green; kill-switch off = byte-identical
  output.
