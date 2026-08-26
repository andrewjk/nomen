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

| Phase | Scope                                                                                                       | Status                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **1** | Asm lifter + validator; wire into every build; round-trip fidelity                                          | ✅ DONE, suite green pre-crash                                              |
| **2** | Frame-slot forwarding + dead-store elimination over the lifted IR (`asm_opt.ts`)                            | ✅ DONE — suite green (2468 tests); measured −1…−5% broad, regex-redux −17% |
| **3** | Extract duplicated semantic lowering (ownership/borrows/moves) into `build_common/` shared by BOTH backends | ✅ DONE — first tranche landed, suite green (253 files / 2468 tests)        |
| **4** | Single canonical IR from the check phase; aarch64 gets real regalloc; eventually NEON                       | endgame                                                                     |

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

## Later phases (design notes)

- **Phase 4**: single canonical IR out of the check phase; aarch64 lowers
  IR→regs with whole-function register allocation (today only loop vars with
  ≥3 reads get promoted); NEON auto-vectorization is the big float lever
  beyond that.
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
