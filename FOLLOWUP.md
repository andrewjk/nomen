# Follow-ups

Skipped or out-of-scope items recorded for later.

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

## Fat-string migration (in progress) — remaining aarch64 work

The repo is mid-migration to fat strings: `string` is now a 16-byte
`{ char* ptr; long len; }` value (`nomen_string`), NUL kept at `ptr[len]`.
`.length` is a field load; strlen survives only at raw-boundary adapters
(C backend) and creation tails (aarch64).

**Current state**: `npm run check` green. C backend: fully green on the
suite. aarch64: core paths green (Map/Set/List/Buffer<string>, literals,
`.length`, concat, `==`, interpolation, ctor pair args); **102 tests still
fail**, all aarch64-side. Remaining clusters:

1. **regex (18)** — `Regex.match` returns garbage length; `Regex.test`
   false. Internal helpers (`first_byte_set`, `find_next_byte`,
   `match_here`) mix free-function pair args with StringBuilder results.
   Harness pattern: `/tmp/smoke12.mjs`-style single-call probes.
2. **json (8)** — JsonTree geometry updated (#48→#56 strides, text
   ptr/len halves); parse/stringify paths still fail — likely string-field
   loads/stores through Buffer<JsonNode> paths not covered by the owning
   specializations.
3. **ansi (7) / string-reassignment (3)** — concat/reassignment chains;
   check `build_assignment_node` aarch64 reassign temps store pairs.
4. **view_params (7) / view_materialize (5) / view_slice (3)** — owned↔view
   bridging after `emit_view_string_arg` became the identity; audit borrow
   normalization for views specifically.
5. **struct string[N] array fields (2+)** — inline fixed-size string arrays:
   ctor element-copy loop copies 16-byte slots by value (aliases pointers)
   and auto_free walks need verification; also `emit_string_array_labels`
   `.quad` tables are 8-byte pointer rows — must become 16-byte {ptr,len}
   rows for string elements.
6. _\*gui_typedef_collision (3), flow-bounds (3), trait_collection_*
   (6), memory-leaks (4), scattered singles_* — re-triage after 1–5.

Known unsupported until widened: `Task<string>`/spawn string RESULTS
(8-byte `result_slot`; Task.nm `result()` loads one word),
`Channel<string>` (8-byte payload design assumption).

### Gotchas encountered (for whoever continues)

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
  nomen_string, `raw_type_size` string→16). Dual-use
  `#arch: c, aarch64_use_c` blocks were SPLIT into per-arch variants in
  Controls/*.nm because the two sides see different param types.
- String literal lengths come from
  `src/build_common/string_literal_length.ts` (unescape-aware); do NOT use
  sizeof-1 (escapes miscount) or the raw token length.
