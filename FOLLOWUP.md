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

## General-path method inlining destroys borrowed receivers (found via PERF work)

`build_inline_method`'s general (non-raw) path mis-handles a struct-field
receiver inside the inlined body: inlining `List.at` (body
`return self.items.load_T(i)`) emitted a `bl Buffer_int_destroy` on
`&self.items` at the inline return — freeing the LIVE backing buffer of the
caller's list (next access segfaults). The cleanup comes from the
receiver-hoisting machinery around the nested `load_T` call; scoped cleanup
stacks are swapped but whatever registers the hoisted temp isn't scoped the
same way when inlined. Raw-only bodies (the naked-inline path) are unaffected
— `Buffer.load_T`/`store_T`/`load`/`store` inline correctly today. Fixing
this would unlock `inline` on `List.at`/`Array.at` and any accessor whose
body calls through a field receiver. Repro: mark `List.at` `pub inline` and
run `test/flow-bounds.test.ts` (aarch64 crashes).

## Map/Set `remove` with string keys leaks moved slots (pre-existing)

Backward-shift deletion moves entries with
`keys.store_T(gap, keys.load_T(k))`. For `Buffer<string>` keys, `store_T`
strdups a fresh copy into `gap` while the moved-from slot `k` keeps its old
pointer; when the cluster walk finishes, `used.store(gap, 0)` marks `gap`
empty, so the buffer's destroy skips it — the stale pointer at the vacated
slot is never freed (one leak per shifted entry). Verified against the
pre-PERF baseline (changes stashed): 60 inserts + 30 removes leaks 45
allocations identically, so the mask-indexing change did not introduce it.
Likely fix direction: an owning-aware shift primitive (free the vacated
slot's strings after the copy), or zero the vacated slot's pointer before
marking it unused.

## Per-call `strlen` of whole strings in per-character helpers (PERF 2.4, deferred)

A helper taking an owned `string` and indexing it per character pays one
`strlen` per CALL; calling it once per line over a large document is
O(lines x bytes). The loop-invariant hoist
(`scan_string_length_hoists`) only covers while loops, not call chains.
Structural fix is an ABI change — thread (ptr, len) through function
boundaries (the `view string` representation already exists for
params/returns) or auto-convert borrows at boundaries. Interim library
pattern: take/return `view string` (verified working; see PERF.md Part 1
bonus).

## Class-per-element lists allocate one malloc per element (PERF 2.5, deferred)

`var Op = Op(); ops.push(mov op)` costs a malloc/free per element; a
value-struct element or parallel `List<int>`s would be flat storage. Needs
escape analysis or value-struct `List<T>` element support (the known
element-ownership pipeline issues). Not a bug — the natural encoding is
just not the fast one yet.
