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

## Reassigning a string to a bare literal stores rodata, then scope-exit
free aborts (pre-existing)

Found while testing the `string.length` hoist. A `var string` initialized
with a literal is heap-allocated (strdup) at declaration, but a later
REASSIGNMENT to a bare literal stores the raw rodata pointer — no strdup —
while scope-exit auto_free still frees it. Output is correct; the program
aborts at exit (audit wrap, exit 134). Confirmed on the unmodified baseline
(changes stashed); crashes on the C backend (aarch64 untested for this
shape).

**Failing shape** (local reassignment in a loop):

```nomen
var string s = "abcdef"
var int total = 0
while s.length > 3 {
	s = "abc"        // free(old); s = <rodata literal> — no strdup
	total += 1
}
Console.write(total.to_string())  // prints "1abc" fine
Console.write(s)
// scope exit: free(rodata "abc") → invalid free / abort
```

Generated C: `nomen_free_wrap(s); s = "abc";` … `nomen_free_wrap(s);` at
auto-free. The same root cause is reachable through a `ref string` param
(callee writes the literal through the ref; the CALLER's scope-exit free
aborts):

```nomen
func truncate_in_place = (ref string s) {
	s = "xy"
}
```

That ref-param shape also crashes on the unmodified baseline. The fix
likely belongs in `src/build_c/build_assignment_node.ts` (reassignment
emit): apply the same literal-strdup ownership rule the declaration path
uses (see `force_heap_strings` / borrow-only analysis), or record the var
as non-owning so auto_free skips it — mirroring `string_borrow_vars`.

## `String.set` traps on aarch64 (pre-existing)

Also found while testing the hoist: a `set` (`ref self`) call writing
chars crashes on the aarch64 backend with SIGTRAP (exit 138); the C
backend runs the same program correctly. Confirmed on the unmodified
baseline (changes stashed). Not yet diagnosed — could be the aarch64
`set` body in `core/System/String.nm` writing through a non-owning
pointer, or an audit trap on a bad free in the ref-self receiver path.

**Failing shape**:

```nomen
var string s = "abc"
var int i = 0
while i < s.length {
	s.set(i, 'x')
	i += 1
}
Console.write(s)   // C prints "xxx"; aarch64 traps (exit 138)
```

