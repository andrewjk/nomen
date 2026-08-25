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

- Enum values stored INSIDE containers/structs: `<Struct>_destroy` (both
  backends) does not walk enum fields' string payloads — storing a
  `Result<string, E>` in a struct field, Buffer, or List leaks it.
- Enum-valued struct FIELD returns (`return self.last_result`) bitwise-copy
  the payload without a boundary copy — aliasing with the field's own
  lifetime is unchecked.
- A match binding that escapes its branch (`case .ok(t) -> return t`) relies
  on the return-boundary borrow normalization; deeper escapes (storing the
  binding) are untracked.

## Backend divergence: `string.to_string()` copies on C, borrows on aarch64

C lowers `string.to_string()` to `strdup(self)` — the result is an OWNED copy.
aarch64 returns the pair unchanged (`mov x0, x19; mov x1, x20`) — the result
ALIASES the receiver's storage. The same program can therefore dangle on one
backend and not the other: `text = body.to_string()` inside a `match` branch
kept working on C but read freed memory on aarch64 once the scrutinee temp was
reclaimed (hit by the bench rewrites; worked around by using the binding
inside the branch).

Fixing it is not just "add a strdup": on aarch64, `string_to_string` results
are deliberately classified NON-heap (excluded in `is_heap_string_expr`, and
absent from `scan_heap_returns`' set), so callers never free them — every
interpolation arg goes through it. Making it strdup without flipping that
classification and auditing all call sites would leak at each one. Needs its
own pass: strdup in the raw body + classify as owned + confirm every caller
(e.g. `_param_N` interpolation temps) frees exactly once.

## aarch64: enum-with-data returns point into the callee's dead frame

An enum-with-data return hands back `x0 = &tag+payload` pointing INTO the
callee's stack frame. It is sound ONLY while the caller copies the blob
before its next call — any intervening call (e.g. a `#destroy` running after
the value was built) overwrites the bytes. `File.read_all`/`write_all` are
shaped around this today (materialize into a local, then `return` the local,
so the pointer targets the returning function's own live frame). Robust long-
term fix: give enums the struct sret convention (caller-provided buffer via
x8) so liveness stops depending on copy timing. Until then, treat "return an
enum built by another call" as a hazard when writing library wrappers.

## `KNOWN_HEAP_RETURNING` is a hand-maintained ownership registry

`src/build_aarch64/utils/scan_heap_returns.ts` hardcodes a set of function
names whose aarch64 results are OWNED heap strings (builtins plus raw `#arch`
library bodies: `File_raw_read_all`, `File_raw_read_line`,
`File_raw_read_chunk`, `Directory_raw_list`, `Http_exchange`, …). The AST
scan below it cannot see raw bodies' returns, so anything not in the set is
treated as a borrow.

Two failure modes, both quiet:

- Add a raw string-returning library function without registering it →
  call sites classify the result as a borrow → nothing frees it → leaks
  surface only as audit `LEAK:` failures in tests exercising that path.
- Rename/remove an entry (this session: `File_readAll` → `File_raw_read_all`
  when the Result API landed) → every existing caller's classification flips
  under it.

A systematic fix could annotate the raw block itself (e.g. a
`#returns_owned` directive parsed alongside `#arch`) so registration lives
next to the body instead of a distant list — but note not all raw
string-returning funcs are owned (accessors returning borrowed storage), so
the directive must be opt-in per function rather than inferred from
`out string`.

## Harness quirk: mono enums vs enums nested in `main`

`parse_with_imports` wraps main-less test input inside `pub func main`, so a
user enum declared in such input lands NESTED while generic monos created
from its use land at root scope. The C header then emits the mono's typedef
before the nested enum's (build order: root enums first), failing clang with
"unknown type name". Real programs declare enums top-level; tests can avoid
it by using library enums or an explicit `pub func main`.

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
