# ASM_PLAN.md — AArch64 backend optimizer (lifted-IR pipeline)

> Working notes for the asm→IR→optimize pipeline. Status as of the crash;
> pick up from **"Current state"** below.

## Goal

Close the scalar gap between Nomen's aarch64 output and clang `-O2`. Measured
evidence from this effort so far:

| approach                                                       | result                                       |
| -------------------------------------------------------------- | -------------------------------------------- |
| Text peepholes over emitted asm (`optimize_asm`, release-only) | perf-neutral                                 |
| Branch-aware condition lowering (in-codegen)                   | −5…−25% (landed)                             |
| Compound-assignment fast path                                  | small (landed)                               |
| fcmp / d0 returns (ABI half-migration)                         | perf-neutral, correctness wins (landed)      |
| Remaining float gap vs clang/Rust/Zig                          | NEON vectorization + whole-function regalloc |

Conclusion: the remaining levers need **dataflow**, which needs an IR.
Text passes can't see liveness; the AST has no per-function CFG.

## Architecture (agreed)

| Phase | Scope                                                                                                       | Status                                                                                                                                                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Asm lifter + validator; wire into every build; round-trip fidelity                                          | ✅ DONE, suite green pre-crash                                                                                                                                                                                                                                                                                                         |
| **2** | Frame-slot forwarding + dead-store elimination over the lifted IR (`asm_opt.ts`)                            | ✅ DONE — suite green (2468 tests); measured −1…−5% broad, regex-redux −17%                                                                                                                                                                                                                                                            |
| **3** | Extract duplicated semantic lowering (ownership/borrows/moves) into `build_common/` shared by BOTH backends | ✅ DONE — first tranche landed, suite green (253 files / 2468 tests)                                                                                                                                                                                                                                                                   |
| **4** | Single canonical IR from the check phase; aarch64 gets real regalloc; eventually NEON                       | 🔄 whole-function regalloc DONE (locals + params, nbody −9%); flow groundwork + canonical NIR stage 1 DONE (planner consumes NIR, codegen byte-identical); CFG + liveness + dominance over NIR DONE; NIR-driven emission tranches 1–2 DONE (if/while/for/switch/match emitted from NIR, byte-identical); NEON + return-from-NIR remain |

## Phase 1 — lifter + validator (DONE)

Files:

- `src/build_aarch64/asm_ir.ts` — instruction contract: mnemonic table with
  per-position operand classes (`r/f/i/c/l/m`), flag set/read semantics,
  ARM32-style aliases used by raw library blocks (`blt/beq/ble/bge/bne`).
  New emissions MUST be added here or the lift fails (the table is the contract).
- `src/build_aarch64/lift_asm.ts` — parser + validator:
  - `validate_asm(code) → LiftError[]` — unknown mnemonics, operand-shape
    mismatches (catches the fadd-on-x-regs bug class), branches to undefined
    labels, conditional branches reading flags nothing set since last
    label/call (AArch64 calls clobber NZCV).
  - `parse_asm_instruction(text, line)` — structured parse, shared with phase 2.
  - `lift_functions(code)` — per-function segmentation (entry = non-dot label
    that is a bl target / .globl'd / preceded by `.p2align`/`.text` /
    previous `ret`).
  - Round-trip fidelity: every line keeps its original text; re-emission is
    byte-identical (tested).
- `test/asm_lift.test.ts` — 11 unit tests + real-build integration test.
- Wired into `build()` (aarch64 branch, always-on): errors go to
  `status.build_errors` → surface as normal build errors.
- Overhead ~1 ms per build (20 KB program). Entire suite green with it on
  (252 files / 2457 tests pre-phase-2).

Known deferrals (documented in code):

- **Stack-balance checking deliberately NOT in phase 1** — a linear scan
  double-counts `sp` adjustments across diamond control flow
  (`b .epilogue` skipping the sibling path's `add sp`; false-positives on
  e.g. `bool_to_string`). Needs per-block analysis → fold into phase 2+
  using the lifted structure.
- Flags tracking resets at labels AND calls only; fine because regular
  AArch64 ALU ops don't touch NZCV.

## Phase 2 — frame-slot optimization (DONE)

File: `src/build_aarch64/asm_opt.ts` — `optimize_frame_slots(code)`.

Soundness model (why this is legal):

- `[x29, #N]` frame slots are private to the function. Callees cannot touch
  them EXCEPT via ref/sret marshalling, which visibly emits
  `add xN, x29, #…` first → treated as an ESCAPE (flush all knowledge).
- Calls preserve slot contents but clobber caller-saved regs
  (x0–x17, d0–d7) → pending stores sourced from caller-saved regs are
  materialized BEFORE the call; availability of caller-saved regs dies.
- Labels/branches are block boundaries: pending stores materialize before
  them (join points may read).
- Forwarding requires exact family+width match (`x64` vs `w32` vs `d64`…);
  mismatched reads materialize pending stores instead.
- `ldp/stp` on frame slots: conservative (materialize pends, clear avail).
- Width-sibling clobber: writing `w0` invalidates availability held in `x0`
  and vice versa.

Transforms implemented in `optimize_frame_slots`:

1. Address-idiom normalization: `add xK, x29, #M` immediately followed by
   `ldr/str XR, [xK]` → direct `[x29, #M]` access, add dropped. Any other
   use of the x29-derived address = escape.
2. Store→load forwarding: load of slot whose pending store sources reg R →
   `mov RD, R`.
3. Redundant-load elimination via availability map (same rules).
4. Dead-store elimination: same-key store overwritten before any read is
   dropped (conflicting family/width stores materialize instead).

Wiring: called unconditionally in `build()` aarch64 branch AFTER
`optimize_asm`, BEFORE audit wrapping; the phase-1 validator runs after all
transforms and will reject any malformed rewrite.

Tests: `test/frame_slots.test.ts` — 10 unit cases (forwarding, dead store,
redundant load, idiom normalization, escape, call clobber/survival, label
flush, width mismatch).

### Post-crash state (resolved)

The crash-time checklist below has since been completed: frame-slot unit
tests 10/10, full suite green (2468), `vp check` clean. Benchmarks were
NOT re-measured after the final `bl`/`blr` flush fix (transform is
perf-foundation work; measure alongside the next perf change).

<details><summary>Original resume checklist (completed)</summary>

1. `npm test test/frame_slots.test.ts` — expect 10/10.
2. `npm test` — full suite (validator + transform now run inside EVERY
   aarch64 build, so any unsoundness or parse gap fails loudly with the
   offending line). Expect possible fallout in tests with unusual raw-asm
   shapes; triage case-by-case (transform bugs vs validator table gaps).
3. `npx vp check --fix` + `npm run check`.
4. Measure (interleaved best-of-N, machine load permitting — check `uptime`;
   this box has noisy background load, interleave old/new binaries):
   rebuild bench binaries via
   `cli/node_modules/.bin/tsx bench/compile_nomen.ts bench/nomen/<b>.nm <out> core aarch64 0`
   for pidigits/fannkuch/nsieve/spectral-norm/nbody/mandelbrot/lru/knucleotide/edigits.
5. If regressions: bisect which transform (forwarding vs dead-store vs
   normalize) via targeted disables; if neutral: keep (foundation) and
   proceed; if wins: update IMPROVEMENTS.md item 30 + PERF.md.

</details>

## Phase 3 — shared semantic lowering (DONE, first tranche)

The semantic DECISIONS that both backends must make identically now live in
`build_common/`; each backend keeps only its own emission action. Landed:

1. `build_common/view_value.ts` (borrows) — `value_struct_name` +
   `is_view_value` were byte-identical copies in both backends'
   `utils/view_value.ts`. The shared layer takes a structural
   `ViewValueStatus`; the backend files keep only their emit halves
   (`c_view_string_arg` / `c_materialize_view_string` /
   `emit_view_string_arg` / `emit_view_materialize_owned`) and re-export
   `is_view_value`.
2. `build_common/nullable_struct.ts` (value semantics) —
   `is_nullable_struct_type` / `has_nullable_struct_field` / `has_flag_name`
   unified; both backend copies deleted, 16 call sites re-pointed.
3. `build_common/temp_anchor_consolidation.ts` (ownership) — WHICH hoisted
   `_param_N` class temporaries are superseded by a capturing result var is
   now one function (`superseded_param_temp_names`). C's action: splice from
   `scoped_declarations`; aarch64's action: mark the anchor slot moved.
4. `is_string_borrow` moved into `build_common/string_return_analysis.ts`,
   defined via the existing `is_call_site_borrow_accessor`, so the
   `.at`/`.first` borrow-name rule has exactly one source; aarch64's
   return-site normalization check now consumes the same predicate.

Verification: `npm run check` clean, full suite green (253 files / 2468
tests), no codegen changes expected (refactor-only).

Remaining duplication candidates (recorded for later, not extracted):

- `collect_allocations` walk (`emit_allocations.ts` both backends) — the two
  versions intentionally differ (C collects LetNode values for statement
  hoisting; aarch64 does not need to). Extraction needs an options flag.
- Owning-Buffer element specialization decision (`has_string_fields` vs the
  C side's `struct_needs_destroy || has_string_fields`): the aarch64 copy of
  `has_string_fields` could move to common alongside `destroy_analysis.ts`.

## Phase 4 — real regalloc → canonical IR (locals+params DONE; flow tranche DONE)

**Whole-function register allocation** (`src/build_aarch64/utils/func_regalloc.ts`):
before a function body builds, one AST scan reserves callee-saved registers
(x23-x26, d8-d11, capped; x27/x28 + d12-d15 stay for loop promotion and
Buffer data-pointer caches) for the body's hottest scalar locals **and
params** (reads ≥ 4). The binding seeds `status.register_allocations` BEFORE
the body build, so declarations initialize the register directly (the literal
fast-paths in build_declaration_node were rerouted through the reg-aware
`emit_var_store`) and every read/write in the function is register-resident
with no loop-entry load / loop-exit store brackets.

Promoted params (params tranche): the prologue spill loop initializes the
register instead of (or in addition to) the home slot — `mov xN, xArg` /
`fmov dN, xArg` for 8-byte params (floats arrive as raw bits in an x
register), or the ordinary spill plus a width-aware load (`ldrb`/`ldrh`/
`ldr w`) for sub-word params. Overflow params load straight from the
resolved overflow slot. Param eligibility: clean scalar types only (no
array/view/ref/nullable/variadic/fat-string); struct/trait/enum/class params
keep the x19-x22 pool; same shadow/ref-arg/address-taken exclusions as
locals.

Soundness model (why this is legal):

- Callee-saved regs survive calls; the existing prologue/epilogue save-restore
  machinery keys off `callee_saved_regs_used`, which the planner seeds first,
  so loops and Buffer caches avoid these regs automatically.
- ESCAPES exclude a name from promotion: passed to a `ref` param anywhere
  (detected from the parse-stamped `ref_param_indices` — the callee may write
  the slot through the pointer), address-taken (collect_var_refs), shadowed
  (declared more than once anywhere in the function, incl. nested funcs), or
  colliding with a param name. Only clean scalar types (no array/view/ref/
  nullable modifiers).
- `emit_var_address` already flushes a promoted reg to its slot before any
  address-take (pre-existing safety net).
- build_function_node now snapshots/restores `register_allocations`,
  `callee_saved_regs_used`, and `buffer_data_cache` around each function
  build — fixing two latent nested-function hazards (bindings leaking into an
  inner build; the inner build clearing the outer's claimed-reg set so its
  prologue saves went missing).
- Inline bodies (`build_inline_method` / `build_inline_function`) now CLEAR
  `register_allocations` while building the body (restoring after): an inline
  param/local sharing the caller's promoted name must not read the caller's
  register (emit_var_load / build_value_node check register_allocations
  FIRST). The caller's claimed regs stay blocked via `callee_saved_regs_used`
  (loop promotion + Buffer caches already avoid that set).
- `build_float_operand` now checks `function_param_regs` BEFORE
  `register_allocations`/`stack_offsets` — an inline float param rides an
  x19-x22 register, and the old order let a same-named caller local win
  (build_operand for ints already had the right order).
- The for/while loop-promotion passes now split `callee_saved_regs_used` by
  register class when avoiding claimed regs — adding every name to the x-set
  left d8-d15 claims invisible to the FLOAT_CALLEE_SAVED scan (latent
  clobber whenever two float promotions overlapped a loop).

Measured (best-of-7 interleaved, small sizes): nbody −9…−10% (its `advance`
population is exactly the multi-loop float case loop promotion couldn't
serve); pidigits/nsieve −1%; rest neutral. No regressions. (Params tranche
not separately measured — foundation; measure alongside the next perf
change.)

Tests: `test/aarch64_regressions.test.ts` — 11 total for phase 4 (promoted
int across calls, ref-arg exclusion, shadow exclusion, promoted float init,
promoted int param across real calls, float param via fmov, bool param
sub-word load, ref-passed local beside promoted param, param shadowed by
local, overflow param, inline-body param not aliasing caller's promoted
register).

### Flow-analysis tranche (DONE)

`src/build_aarch64/utils/func_flow.ts` — the liveness groundwork the plan
called a down-payment. `plan_function_promotions` now gets its variable
facts from ONE full-coverage walk (`collect_weighted_var_refs`) instead of
per-statement `collect_var_refs`, which was structurally blind in three
places:

1. **If branches**: `IfElseNode` stores `if_branch`/`else_branch`
   (`BranchNode`s); the old scanner read `statements`/`else_statements`,
   which don't exist on it → every identifier inside an if body was
   invisible. Missed reads under-promoted; missed ADDRESS-TAKES left a hole
   in the promotion exclusions for variables only addressed inside branches.
2. **Method-call arguments**: `AccessFunctionCallNode` carries `params`; the
   old scanner read `.args` → method args (reads AND ref-swapees) never
   counted.
3. **Switch/match arms**: case wrappers are plain `{condition, branch}`
   objects without a `node_type` tag → arm conditions/bodies never walked.

The walk also records each name's LOOP-NESTING-WEIGHTED reads
(`reads × 8^depth`) alongside raw counts. A/B outcome: weight-FIRST ranking
inverted `advance`'s d-pool order (params demoted to slots) and measured
neutral-to-slightly-negative (nbody −~1%, spectral-norm −~0.6% medians,
pidigits/nsieve even; quiet-window re-run had spectral marginally ahead and
nbody noise-bound). Landing shape: eligibility unchanged (raw ≥ MIN_READS +
all exclusions), ranking = raw desc with WEIGHT as tie-breaker only;
outputs are untouched where counts didn't change, while functions whose
reads live in if/method/switch regions may now promote at all. The full
weighted profile stays exported for the future IR allocator's cost model.

Tests: `test/func_flow.test.ts` — 5 unit tests (weighted depth math incl.
legacy LHS-target counting, address-take marks via access receivers,
method-arg visibility, tie-break-by-loop-heat under pool contention,
if-branch coverage pushing a var over MIN_READS).

Measured: perf-neutral (foundation + soundness fix); see IMPROVEMENTS.md
item 31.

### Canonical IR stage 1 — NIR + planner migration (DONE)

`src/nir/` — the canonical IR (Nomen IR, or NIR) now EXISTS and has its
first real consumer.

- `nir.ts` — closed, tagged union of statements (`declare/assign/eval/if/
while/for/switch_match/return/break/continue/exit/raw/spawn/async_block/
nested_func/anon_struct/opaque`) and expressions (`leaf/binary/wrap/call/
method_call/path/other`). Structured (no flat blocks — the language has no
  goto), fact-carrying (`ref_arg_indices`, swap swapees, receiver positions,
  declaration modifiers ride the IR explicitly), and exhaustive: new AST
  constructs must be given a mapping or they surface as `other`/`opaque` AND
  get recorded in `unknown_kinds`, so silent blind spots are structurally
  impossible. Consumers switch exhaustively (`never` guards).
- `from_ast.ts` — one-direction lowering from the checked AST. `lower_function`
  returns the NIR plus the `unknown_kinds` coverage set; nested `func`
  statements lower INLINE so nested declarations still shadow-count against
  the enclosing function (matching the historical conservative scans).
- `traffic.ts` — `analyze_traffic`/`analyze_function` produce raw +
  loop-weighted reads, address-take marks, declaration counts and ref-arg
  names via one typed exhaustive walk. Semantics are byte-for-byte the
  func_flow.ts counting rules (assignment targets count one read; access
  roots and swap swapees are address-taken; loop bodies/conditions weigh one
  level hotter at 8^depth, capped at 4).
- `func_regalloc.plan_function_promotions` now lowers to NIR and consumes
  `analyze_traffic`; the duck-typed generic-descend `scan()` and
  `utils/func_flow.ts` are deleted. Plan inputs (eligibility, ranking,
  tie-breaks) are unchanged.

Refactor-only proof: generated `.s` is byte-IDENTICAL on
nbody/spectral-norm/pidigits/nsieve/fannkuch/mandelbrot/binarytrees versus
the pre-NIR builds. Tests: `test/nir.test.ts` — 8 cases (weighted-depth math
incl. legacy assignment-target counting, receiver address-take marks,
method-arg reads + ref-arg exclusion facts, tie-break-by-loop-heat pool
contention, if-branch coverage over MIN_READS, exotic-statement corpus with
`unknown_kinds` asserted empty, every `bench/nomen/*.nm` function lowered +
analyzed with empty unknown sets, identifier-classification parity).

### CFG + liveness + dominance tranche (DONE)

The liveness groundwork the plan said NEON needs before a vectorizer can
exist.

- `src/nir/cfg.ts` — flattens the structured NIR into basic blocks with
  explicit terminators (`goto/branch/return/exit/unreachable`). `if` gets
  then/else/join blocks (join always exists, so phi-style consumers have a
  home); `while`/`for` get header/body/update/exit blocks with break/continue
  target stacks (`continue` → update block, `break` → exit); `switch`/`match`
  lower to the backend's sequential condition-chain shape; falling off the
  end leaves an `unreachable` terminator (the epilogue is backend-emitted).
  `nested_func` bodies become their own `FunctionCfg`s (a nested declaration
  never executes at its declaration point; the checker rejects closures, so
  nothing is lost). Facts ride the flat statements: `reads`/`defs`/`barrier`.
  Defs include may-defs — ref args, swap swapees, method receivers, path
  assignment roots, and (new on the NIR assign variant) `operator`, so a
  compound target's old value counts as read while a plain target is a pure
  def. `raw`/`opaque`/`other` are LIVENESS BARRIERS (reads/defs = whole
  name universe). Name-keyed, matching the backend's name-keyed
  `stack_offsets`; names read but never declared (checker-injected
  `_param_N` temps) still join the universe.
- `src/nir/analysis.ts` — the passes: forward-computed block use/def (a read
  is upward-exposed only if no earlier statement in the block defined it) +
  iterative may-liveness fixpoint (`analyze_liveness`); reachable set, RPO,
  iterative dominator sets → idoms → dominator tree → dominance frontiers
  (`analyze_dominance`); natural loops from back edges with body, latches,
  exits and containment-based nesting depth, plus per-block loop depth
  (`analyze_loops`); `analyze_cfg` runs all of them.

Refactor-only proof: no codegen consumer yet, so generated `.s` is
byte-identical by construction. Tests: `test/nir_cfg.test.ts` — 10 cases
(straight-line/diamond/while/for-break-continue/early-return/match-chain
shapes, idom + frontier assertions, loop-carried liveness, ref-arg may-defs,
raw-block barrier, nested-function separation, and a full-corpus run over
every `bench/nomen/*.nm` function asserting idom validity and
liveness/loop invariants).

### NIR-driven emission tranche 1 (DONE)

The aarch64 BACKEND now consumes the canonical IR at emission time — stage 2
begins.

- `src/build_aarch64/emit_nir.ts` — `emit_stmt_from_nir` +
  `status.nir_emit_ctx`. `build_function_node` lowers the body to NIR ONCE
  and shares that one lowering with `plan_function_promotions` (which now
  accepts a pre-lowered `NirFunction` instead of re-lowering); when
  `unknown_kinds` is empty the body's lowered statements are published as
  the emission ctx and `build_block_node`'s statement loop dispatches
  through `emit_stmt_from_nir`. Alignment is by ARRAY IDENTITY: the ctx
  carries the exact AST statement list it drives, so a nested block build
  that doesn't own the list (inline method bodies, delegated
  for/switch/match branches, method bodies from `build_struct_node`,
  spawn/async bodies) fails the check and falls back to the AST walk —
  misalignment structurally cannot corrupt emission. Per-function fallback:
  any function whose body maps incompletely (e.g. a nested `struct`
  declaration → `unknown_kinds`) walks the AST exactly as before.
  `set_nir_emission_enabled` is the A/B kill-switch.
- `if`/`while` are emitted NIR-NATIVELY: `build_if_else_node` /
  `build_while_loop_node` accept the lowered branch/body lists and hand them
  to their nested blocks (`build_branch_block` / `build_loop_body_block`,
  which also CLEAR the ctx for delegated sub-builds). Label numbering
  (shared `next_if_label`/`next_while_label` accessors), scope frames,
  buffer-cache snapshots, branch-aware cond lowering and store-backs stay in
  the builders — both paths are literally the same code, so drift between
  "NIR mode" and "AST mode" is impossible by construction.
- Everything else delegates to `build_node` unchanged (later tranches take
  over `for`/`switch`/`match`/`return` at this same dispatch point — the
  seam where the vectorizer and liveness-gated decisions attach).
- Dedup (phase-3 style): the duplicated while/for loop-promotion cores
  (~110 lines each) are extracted into `utils/loop_promotion.ts`
  (`promote_loop_locals`), consumed by BOTH builders.

Proof: byte-IDENTICAL `.s` versus the emission cursor disabled — asserted
per-program by `test/emit_nir.test.ts` (if/else, while + promotion +
break/continue, nested whiles, for, match, switch, raw `#arch: aarch64`
statements, nested funcs, unknown-kind fallback) AND over the full
`bench/nomen/*.nm` corpus; a mutation check (marker injected into the NIR
branch) confirms the path actually executes. Full suite green (256 files /
2516 tests). Perf: byte-identical output by design; build-time cost is one
extra NIR lowering per function (stage 1 measured the lowering at ~free).

### NIR-driven emission tranche 2 (DONE): native for/switch/match

The remaining structured control flow is now emitted NIR-natively at the
same dispatch point.

- `emit_stmt_from_nir` gained `for` and `switch_match` dispatch arms
  (`switch` and `match` share the one NIR kind — the AST `node_type` picks
  the builder). `return` deliberately stays delegated: it has no nested
  statement list to drive, so its takeover belongs with NIR-level
  EXPRESSION emission, not this tranche.
- The cursor mechanics are deduped into ONE shared helper,
  `emit_nir.build_block_with_cursor(block, stmts, status)` (set ctx to the
  lowered list when available, CLEAR it when not, restore after). The
  previously duplicated private helpers in `build_if_else_node`
  (`build_branch_block`) and `build_while_loop_node`
  (`build_loop_body_block`) are deleted; `build_for_loop_node` (all THREE
  iteration paths: range / Enumerable / array), `build_switch_node` (per
  case + else) and `build_match_node` (per case + else) all consume it.
  Builders keep everything semantic — label numbering (per-builder counters
  shared with the AST path via `next_if_label`-style accessors), loop
  promotion, for-ref writebacks, match payload bindings, hoisted scrutinee
  temps, buffer-cache snapshots — so "NIR mode" and "AST mode" remain the
  same code by construction.
- A side benefit: an if/match/switch nested INSIDE a for body or a match/
  switch arm now installs its own cursor (the enclosing builder no longer
  delegates with the outer ctx still active), so nested structured flow is
  fully cursor-driven end to end.

Proof: byte-IDENTICAL `.s` versus the emission cursor disabled —
`test/emit_nir.test.ts` extended to 16 tests (array-iteration for,
for-ref writeback, enum-with-data match with payload bindings parsed RAW,
for/match nesting with block arms, plus the tranche-1 set) AND the full
`bench/nomen/*.nm` corpus. Mutation checks (markers injected into the new
`for` and `switch_match` dispatch arms) confirmed both arms execute and
were reverted. Behavioral test runs the NIR-built binary (for/of +
for-ref + payload match → `536 1`). Full suite green (256 files / 2521
tests). Perf: byte-identical output by design.

### Remaining phase-4 work (NOT done)

- **Canonical IR stage 2+** — tranches 1–2 are DONE (if/while/for/switch/
  match native; per-function eligibility + delegation). Remaining: NIR-level
  EXPRESSION emission (which is also what `return`'s dispatch takeover
  waits on), then the C backend, then retire the duplicate AST walks
  entirely. Stage 1's closed union + coverage sets are the contract those
  passes build against.
- **NEON auto-vectorization** — the CFG/liveness/dominance substrate now
  exists (`src/nir/analysis.ts`: loop discovery with nesting depth, block
  liveness, frontiers). What remains is the vectorizer pass itself over
  loop bodies plus a lowering path that can emit NEON from the NIR.
- Known pre-existing divergence found while testing (recorded in
  FOLLOWUP.md): a shadowed local read after its scope diverges between
  backends (aarch64 `x=10` vs C `x=8`); `stack_offsets` is name-keyed.

## Later phases (design notes)

- **Phase 4**: single canonical IR out of the check phase; aarch64 lowers
  IR→regs with whole-function register allocation (locals + scalar params
  both promote today; see above); NEON auto-vectorization is the big float
  lever beyond that.
- Stack-balance validation: implement over lifted blocks (per-block delta,
  join = require equal deltas or unknown) once phase 2 blocks exist.

## Session context that may matter

- Machine timing is unreliable (background load; load avg has hit 3–7.5).
  Always interleave old/new binary timing; distrust single-run numbers.
- Known-flaky test: `file.test.ts > File.delete removes the file` — ignore.
- Related landed work this session (all committed? NO — everything is
  uncommitted in the working tree): --release flag, optimize_asm, fcmp +
  d0 returns + fneg fix, float += fix + compound fast path, mutable-param
  compound operand-order fix, branch-aware cond lowering, inline string.at,
  regex prefilter extension + negated-class miscount fix, spectral-norm
  float-recurrence REVERTED (kept integer recurrence), knucleotide/
  regex-redux docs updates, PERF.md, IMPROVEMENTS.md items 23–29.
