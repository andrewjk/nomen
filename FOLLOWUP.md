# Follow-ups

Skipped or out-of-scope items recorded for later.

## Must-use enforcement for `Result`-returning IO (design agreed, not built)

All fallible File/Directory operations now return `Result<T, FileError>` /
`Result<T, DirectoryError>`, but the compiler does NOT force callers to handle
the result: a bare statement call (`f.open(p, "r")`) still silently discards
it. Agreed design, deferred as its own scope:

- Mark the generic `Result` enum declaration must-use (attribute-style marker
  on the enum), so ANY Result-typed value discarded in statement position is a
  compile error.
- Explicit escape hatch: bind to `_` or `match` on it — ignoring/panicking is
  fine, it just has to be deliberate.
- Enforcement point: checker walk where statement-position calls are checked
  (AccessFunctionCallNode.is_statement already exists as a hook).

## Http API still reports failures softly

core/System/Stream/Http.nm was not converted to the error-enum pattern; it
should get an `HttpError` + `Result<..., HttpError>` API like File/Directory
did (465 lines of raw bodies across both backends — its own pass).

## Enum-with-string-payload ownership edges

The core contract now works end to end on both backends (case construction
strdups string args; enum locals free payloads at scope exit; match hoists
call scrutinees into owned temps and frees them; reassignment frees the
displaced payload). Not yet covered:

- The checker does not reject storing a BORROWED class value (e.g. a plain
  non-`mov` param) into an OWNING class field (`self.art = b` with
  `func f = (ref self, Box b)`): the callee's field destroy frees it AND
  the caller's auto-free frees the same temp — both backends double-free.
  The documented model (MEMORY.md) requires `mov T` for owning mutators;
  a checker rule mirroring the rejected `b = a` owning-struct copy would
  close it.
- Enum values stored INSIDE containers/structs: `<Struct>_destroy` (both
  backends) does not walk enum fields' string payloads — storing a
  `Result<string, E>` in a struct field, Buffer, or List leaks it.
- Enum-valued struct FIELD returns (`return self.last_result`) bitwise-copy
  the payload without a boundary copy — aliasing with the field's own
  lifetime is unchecked.
- A match binding that escapes its branch (`case .ok(t) -> return t`) relies
  on the return-boundary borrow normalization; deeper escapes (storing the
  binding) are untracked.

## Cold-run parallel test flakiness (pre-existing)

A fully cold `npm test` (after `rm -rf test/out`) with default file
parallelism shows ~25-35 spurious failures (empty `output.txt` files written
for tests whose binaries run fine standalone — e.g. `file.test.ts`,
`ziglings/107_files2.test.ts`, plus a broad scatter). Reproduced on the
unmodified baseline (changes stashed), so it is not a codegen regression.
A second (warm) run is fully green, and a cold run with
`--no-file-parallelism` is fully green — it looks like a
concurrency/caching artifact in `check_output`'s cache write under load.
Worth investigating `test/check_output.ts`'s `outputfile`/`cachefile` writes
if it keeps biting.

## Residual ownership-tracking gaps (accepted, narrow)

- **Trait-dispatched value-struct methods bypass the self-write record
  drop**: `scan_self_string_field_writes` resolves the concrete method only
  for direct (non-vtable) calls, so a `self.<string field> = …` inside a
  method reached through a trait-typed receiver can still leave the caller's
  `heap_string_fields` record stale. The record drop also intentionally
  leaks the displaced heap value (dropping without freeing is the only sound
  option when the write is conditional) — see
  `drop_self_written_string_field_records` in
  `src/build_common/scan_self_string_writes.ts`.

  **Failing shape** (aarch64 takes the `trait_target` vtable path in
  `build_access_node`; C dispatches via `_get_trait_func(...)` — neither
  drops the record):

  ```
  trait Resettable { func reset = (ref self) }
  struct Person : Resettable {
    var string name
    func reset = (ref self) { self.name = "X" }   // stores rodata, not heap
  }

  var Person p = Person("Alice")
  p.name = 42.to_string()    // record: "p.name" is heap-owned
  var Resettable r = ... p   // trait-typed receiver
  r.reset()                  // vtable dispatch — record NOT dropped
  // scope exit: stale record frees the literal "X" → invalid free / abort
  ```

  **Fix tiers** (in increasing generality/cost):

  1. _Cheap, partial_: when the receiver is a trait-typed **local**, the
     concrete struct is recoverable from its initializer (the backends
     already do this for destroy dispatch via `resolve_decl_struct` /
     `trait_class_locals`). Resolve it and apply the same scan/drop. Covers
     `var Trait t = Concrete(); t.method()`.
  2. _Conservative, general_: for receivers whose concrete type is genuinely
     unknown (`ref Trait` params, trait-typed collection elements), scan
     **every** conformer's implementation of that trait method and drop the
     union of written string-field records. Sound, but over-drops on
     field-name collisions across conformers (extra leaks, never
     double-frees).
  3. _Systemic_: make value-struct string fields always-heap like class
     fields (strdup on construction/assignment, free on destroy). Deletes
     the entire `heap_string_fields` mechanism and this bug class with it —
     but heap-allocates every literal stored in a value struct and touches
     init/destroy/mov/return paths everywhere. Real perf cost, much bigger
     change.

  **Risk today**: requires all of value struct + plain string field + a heap
  value previously assigned into it + a trait-dispatched method whose
  concrete impl overwrites it with a non-heap value. Classes are immune
  (always-heap fields); core containers don't use this shape (full suite,
  including trait-heavy tests, passes). When it bites, it's the same
  invalid-free abort the direct-call fix addresses, reached via vtable.
  Exposure is strictly no worse than before the fix — the direct-call path
  was the hole that was closed; this is the unfixed remainder.

### ASM gotchas (kept for future work)

- `ldp/stp` simm7-scaled range tops out at **+504** — use the guarded
  helpers (`emit_pair_load_x29` / `emit_pair_store_x29` /
  `emit_string_pair_load/store` in `src/build_aarch64/utils/string_pair.ts`)
  or split ldr/str pairs.
- String-receiver methods: self pair occupies AAPCS slots 0–1 → first real
  param starts at x2 (`start_reg = 2` at call sites; callee prologue
  `slot_idx += 2`). `ref string` self stays ONE slot (&slot) — see
  `self_is_string` gating in build_struct_node.
- Call-site pair detection is by ARGUMENT static type
  (`type_from_value_node(param)?.name === "string"`), NOT callee param
  types — generic signatures (`TK key`) stay generic post-mono.
- `_string_interpolate_N` (aarch64, build.ts): overflow pairs k≥3 read
  from `[x29_helper, #(16 + (k-3)*16)]`.
- Raw `#arch: c` bodies are thin (char*) behind `_raw_` adapters
  (`raw_string_abi.ts`); T-generic container bodies (Buffer_/Array_/…)
  are natively fat via checker substitution (`raw_c_type_name` →
  nomen_string, `raw_type_size` string→16 — and it must mirror
  struct_layout's ALIGNED sizes). Dual-use
  `#arch: c, aarch64_use_c` blocks were SPLIT into per-arch variants in
  Controls/*.nm because the two sides see different param types.
- String literal lengths come from
  `src/build_common/string_literal_length.ts` (unescape-aware); do NOT use
  sizeof-1 (escapes miscount) or the raw token length.
- Any emitted assembly that must survive a `bl` may only rely on
  callee-saved registers (x19–x28, sp) or stack slots — x0–x18 are
  caller-saved and clobbered by the callee.

## Plain string assignment aliases (value-semantics hole, both backends)

Found while landing STRING_PLAN tranche 4 (2026-09-06): `s = t` between
two owned strings does NOT strdup on either backend — it pair-copies,
frees the displaced target value, and leaves the heap block owned by
the SOURCE (only the source frees at scope exit). The two variables
alias the same bytes:

- aarch64 probe: `s = t` then a write through `ref s` (raw-body
  mutator, so no compile-time escape hatch involved) — BOTH `s` and
  `t` print the mutation (`Xaaa`).
- C backend: `free(s.ptr); s = t;` struct assignment — same alias.

String mutation is only reachable through `ref self` dispatch
(`String.set`), so the hole needs a `ref` on the assignee after a
plain var-to-var assign — narrow, but it violates the documented value
semantics of assignment (MEMORY.md: strings are per-variable owned
heap buffers; the language rejects plain `b = a` for owning STRUCTS
for exactly this reason, yet allows it for strings with move
semantics).

Options when this is picked up:

1. Restore value semantics: strdup on plain string assign (the
   tranche-4 note's original assumption). Costs a strdup per var-var
   assign; keeps every current valid program correct.
2. Embrace move semantics: keep the transfer, mark the source moved
   (zero its slot / moved set) so post-assign reads are compile
   errors and the alias becomes unreachable. Aligns with how the
   backends already treat it, but is a LANGUAGE change (spec the
   assign-time move) and touches the checker's flow tracking.

Not fixed in the tranche (out of scope; tranche 3's mutation scan
keeps borrow positions isolated). Recorded for the semantic owner.

## Region-pool receiver pins — RESOLVED (default ON, 2026-09-06/07)

ASM_PLAN_5 tranche 1 (`region_pool.ts`: region-scoped callee-pool claims +
loop-pinned Buffer data-pointer materialization) is now **default ON** after
the soundness hunt closed all four holes. The receipts (each caught by the
build-both-arms/diff discipline):

1. **Pin register ABI**: the pin is a CALLEE-SAVED register — using it
   without riding the prologue/epilogue save/restore destroyed the
   CALLER's live value (first_child's pin clobbered measure_w's x25 —
   layout's `800x30`). Fix: chosen pins join `plan.callee_saved`, and
   `region_pool_exit` no longer deletes them from the live claim set.
2. **Shared registers**: N non-interfering ranges share one register with
   N DIFFERENT values — a single loop-exit reload restores one (edigits:
   five shared limb temps, four corrupted). Registers with >1 occupant
   are refused.
3. **Emit-time bindings**: loop promotion (tranche D) claims registers at
   emission and installs them in `register_allocations` as scopes open —
   invisible to the plan-time occupant map. The inner c-loop's induction
   `c` was promoted into x24 by the outer loop's promotion and the
   bracket's digits.data derivation destroyed it (edigits' `0 :1`).
   Fix: `region_pool_enter` refuses pin registers bound in the live
   `register_allocations` (tranche 2 refines this to the per-pin dead
   set — function-wide occupants stay bound whether or not they are
   live, so only unknown keys refuse).
4. **Ordering/counting** (attribution, path-assign refusal, entry-load
   accumulation, positional dest-and-source reads) — fixed in the first
   landing.
5. **Share-into-pin** (tranche 2, knucleotide count_seq segfault):
   promotion's interference-SHARING could not see the pin and shared the
   j-loop induction onto the data-pin register
   (`ldr x0, [x26, x26, lsl #3]`). Fresh claims already avoided pins via
   `callee_saved_regs_used`; only the sharing path was blind. Fix:
   `status.region_pinned` (bracket-maintained, nesting-disciplined);
   `can_share_claimed_register` refuses pinned regs.
6. **Nesting-incomplete loop bodies** (tranche 2, lru segfault):
   analyze_loops' latch pred-walk missed nested blocks, so the outer
   find-loop tested its inner sh-loop's induction dead (members disjoint
   from the incomplete set) and borrowed its register for the whole outer
   bracket. Fix: `region_loop_blocks` (header-dominates + reaches-header,
   unioned with the analyzed set) drives every region check — union-only
   ever refuses more pins.

## Tranche-3 shelved pieces (measured, not shipped)

ASM_PLAN_5 tranche 3 landed the ext-borrow machinery + hardenings; these
were tried in the same session and reverted:

- **x15 reservation**: withholding x15 function-wide whenever any loop
  holds a pinnable accessor cost +0.02 on pidigits (0.545 vs 0.525
  medians, 6/6 interleaved pairs slower) and LOST the D6 x23/x24 pins
  (the pool shift moved x25 live into D6). Without it a D4 loop borrowed
  x14 (the first ext pin ever fired) but net pins dropped 4→3 and timing
  still trailed baseline. Verdict: pool-shift cost exceeds pin benefit at
  this shape; revisit only with a per-function proven trade.
- **Nested-loop pin refusal**: skipping pins for loops containing nested
  loops (try_count ≤3 receipt: bracket cost > savings). Pin set unchanged
  with/without in pidigits — unmeasured benefit, shelved to keep the
  tranche codegen-neutral.
- **collect_var_refs coverage** (method-arg params under `access_func`,
  if/match/switch branch fields, ref/mov address-taken): real dead code
  (`"access_function_call"` matched nothing; if-branches never walked),
  but broad promotion effects need their own tranche with isolated
  timing receipts. The coupled `_param_N`/`_vn_N` promotion exclusion
  SHIPPED (forwarding elides their declares — garbage-index crash
  guard; neutral).
- **Promotion site-sharing**: sharing loop claims onto decl-site regs
  under the adjacency proof. Reverted to the stage-3 never-touch rule;
  needs an isolated receipt (the D-arm collision it targets carries an
  edge and refuses by construction, but no bench proves the gain).

Full bench matrix byte-identical across backends; pidigits n=4000
0.63 → 0.53 s baseline-relative (the whole ASM_PLAN_5 arc: 1.89× →
**~1.53×** vs C `-O2`); fannkuch-redux −28%; suite green (290 files /
2816 tests) with `test/region_pool.test.ts` + the harness holding the
pass in both arms (it is emission-driven, so the corpus harness runs it
in both — it is not a cursor-dependent transform).

The substrate (plan-side region-free computation, block-membership
liveness, the bracket + pre-seed mechanics) is sound where it fires on
BigInt-shaped methods; the hunt for the remaining invalidation is the
gate for flipping the default.

- **Session-2 forensics note**: the preheader `_vn = wd_off + u_len + 1`
  hoist IS firing in div_to's D4 loops (confirmed in the .s preheader);
  the in-body index chains still read u_len from its slot and rebuild.
  The VN rewrite reaches the NIR spine, but the accessor's index staging
  builds from the AST arg tree — whether the recorded eval+argN splice
  survives to the eval dispatch for THESE statements is the open
  question. A hand-written digit-extraction mini had its own
  loop-terminator bug — rebuild the repro from the test harness
  (check_output's audit path) instead.

## Raw `#arch: aarch64` blocks assume param registers, which control flow clobbers

Found while writing the switch-case mutation-gate test in
`test/borrow_to_string_elision.test.ts`: a raw asm block that reads its
parameters crashes at runtime when it sits after any control flow. The raw
block ABI hands params in `x0`, `x1`, … at function entry, and the emitter
splices the block verbatim wherever the statement sits — but by then the
backend has evaluated other expressions into those registers. Repro
(`func raw_touch = (string p) { switch { case true { raw } } }`, asm from
`test/out/aarch64/.../main.s`):

```
str x0, [x29, #0]   // param p spilled to its slot
mov x0, #1          // switch condition reuses x0
cmp x0, #0
beq end_switch_0
mov w2, #74
strb w2, [x0]       // raw block still expects p in x0 → writes to address 1
```

The C backend is unaffected (raw C bodies reference params by name through the
generated glue). Entry-position raw blocks — the shape all of `core/` and
the existing tests use — are fine. Fix directions: reload the params into
their ABI registers immediately before each raw statement (the values are
already in the slots the prologue spills them to), or have
`asm_validator`/`lift_asm` reject a raw block that is not preceded only by
prologue code, or document raw blocks as entry-only for aarch64. The same
clobber class applies to any `if`/`while`/`match` body, not just `switch`.

## `validate_asm` rejects raw-block GNU numeric local labels (pre-existing)

`BigInt.div128`'s `#arch: aarch64` body uses numeric local labels (`1:`,
`2:` with `b.hs 1f` / `b 2f` branches). Any single-TU aarch64 build that
compiles `div_to` (bench programs, `test/induction_pin.test.ts` probes)
reports `asm: branch to undefined label '1f'` / `asm: unparseable
instruction — 1:` build errors, even though the emitted text assembles and
runs correctly (clang accepts the labels; the bench harness ignores
`result.errors`). Other passes already understand the forms
(`asm_cycle_dead_moves`' CFG resolves numeric `1f`/`1b`; `lift_asm.ts`
mentions GNU numeric labels) — only the validator's label table does not.
Fix direction: teach `validate_asm` (and the stack-balance validator) the
numeric-label definition/reference forms. Found during ASM_PLAN_7 tranche
2 (the div_to induction census builds `div_to` single-TU); left alone as
out of scope — the tranche's tests filter the known messages.

## Unmodeled calls: `tree_is_call_free` misses struct operator calls (latent)

Same unmodeled-call class as the tranche-2 hang receipt, on the OTHER
consumer: `tree_is_call_free` (AST) recurses through `op` nodes without
noticing `operator_func`, so a loop whose only "calls" are string `+`
(`bl string_add` + `bl _free`) verifies call-free and emit-time loop
promotion opens the caller-saved `x12–x15` extension pool inside it.
Tranche 2 fixed only its own path (induction pins carry a heap-freedom
proof: no `operator_func` op, no string traffic, no non-scalar in-region
declare, no foreign heap write) and confirmed no regression, but a hot
string loop with 10+ hotter loop-carried ints would still place live
values in call-clobbered registers via promotion on clean HEAD (scratch
asm shows `x12–x15` traffic in such a loop; no miscompile receipt yet —
needs a dedicated repro + the shared fix: refuse `operator_func` ops in
`tree_is_call_free` and flag them in the NIR fact walk's `has_call`, so
the refuse gate covers every region consumer at once).
