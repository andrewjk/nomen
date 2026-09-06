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

## Region-pool receiver pins: unsound on ref-param receiver loops (DEFAULT OFF)

ASM_PLAN_5 tranche 1 shipped `region_pool.ts` (region-scoped callee-pool
claims + loop-pinned Buffer data-pointer materialization) **default OFF**
via `set_region_pool_enabled(false)` — the pidigits/fannkuch wins are real
(measured with the switch forced on) but the invariance proof has an
unisolated hole:

- **Passes**: BigInt's Knuth-D/D2 loops (div_to/mul_to) — outputs
  byte-identical, pidigits n=4000 0.55 → 0.53 s, fannkuch-redux 2.12 s.
- **Corrupts**: layout engine (wrong measured widths), lru (build fails),
  edigits/knucleotide (wrong output) — all Buffer-heavy non-method code
  with `ref`-param receivers.
- **Already fixed during bring-up**: two receivers sharing one pin
  register (spectral-norm aliased data pointers — one pin per receiver
  now); foreign root-writes vs the accessor's own receiver may-defs
  (attribution by statement); path-assign root-defs now refuse
  unconditionally; entry loads accumulate instead of overwriting;
  dest-and-source reads counted positionally.
- **Remaining suspect**: an unmodeled invalidation on `ref`-param
  receivers — the pinned cell (root.field.data) changing through a path
  the NIR def facts don't attribute to the loop (e.g. a ref-arg of the
  PARENT struct reaching a call-free-refined inline that grows the
  field, or a scope-frame binding whose liveness membership is computed
  on the renamed view while the emitter binds by source name).
- **Forensics recipe**: `NOMEN_REGION_OFF=1` / `NOMEN_REGION_NOSEED=1`
  env bisects (the env checks are removed — re-add temporarily), then
  diff the per-function `.s` (layout_vstack's diff isolated the
  add_vstack/add_leaf hoists).

The substrate (plan-side region-free computation, block-membership
liveness, the bracket + pre-seed mechanics) is sound where it fires on
BigInt-shaped methods; the hunt for the remaining invalidation is the
gate for flipping the default.
