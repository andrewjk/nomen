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

## `string.length` lowers to a per-call `strlen` — hoist loop-invariant lengths (perf)

`x.length` on a `string` emits a real `strlen(x)` call at every evaluation;
it is not a field read. In loop conditions this is O(len) **per iteration**,
making any char-walking loop O(len²). The differator port's
`split_lines`/`substring`/`fnv32`/`ends_with_newline` family scans a whole
document byte-by-byte, so splitting a 257 KB / 10k-line file took **2.7 s**
— every single iteration re-ran `strlen` over the full 257 KB (~33 GB of
scanning). Every diff entry point (`myers`, `histogram`, `combined`) was
bottlenecked by this shared infrastructure, not the algorithms.

**Shape in the port** (`core`-style user code, `differator/nomen/src/diff.nm`):

```nomen
pub func split_lines = (string text, out List<Line>) {
	var List<Line> lines = List<Line>()
	var start = 0
	var i = 0
	while i < text.length {          // <-- strlen(text) every iteration
		if (text.at(i) as int) == 10 {
			...
		}
		i += 1
	}
	...
}
```

Generated C for the condition: `while (i < ((long)strlen(text)))`.

**Fix tiers**:

1. _Targeted codegen_: recognise a loop whose condition compares an
   induction variable against `string.length` of a loop-invariant string
   (parameter or un-reassigned local) and hoist the `strlen` into a temp
   before the loop — mirroring what the bounds analyser already knows (it
   tracks `text.length` as a symbol for constraint discharge, so the
   invariance fact is available).
2. _General LICM_: a small loop-invariant code motion pass over call-ish
   expressions with no side effects (`strlen` on an invariant pointer is the
   main one; `List.length` is already a field read).
3. _Representation_: prefix- or side-table-stored string lengths, making
   `.length` a load. Biggest change (ABI, all backends, interop), but kills
   the whole class.

**Interim user workaround**: bind `const int n = text.length` before the
loop and compare against `n`. Note the bounds checker already discharges
`at(i)` through an `n` aliasing `text.length`, so the workaround costs
nothing in checkability. BENCH note: the differator benchmarks will look
quadratic until this lands.
