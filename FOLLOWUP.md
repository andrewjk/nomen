# Follow-ups

Skipped or out-of-scope items recorded for later.

## Unrolling corrupts mandelbrot since the int-side codegen tranches (pre-existing)

With `set_loop_unrolling_enabled(true)` (default OFF — nothing shipped is
affected today), mandelbrot at n=1000 prints `checksum 50800640` instead of
the correct `checksum 12649259` (C backend + unflagged aarch64 agree on the
latter). Bisected with `git bisect run` (unroll-flagged build + checksum
diff): **first bad commit 44e05e79 "Perf: int-side register codegen
tranches"** (ASM_PLAN_2 tranche F). The composed unroll of main's 8-bit
loop multiplies the inlined `mbrot` expansion ×8, so the corrupting shape
is tranche F's int dest-hint / int-tree codegen (or its register-claim
bookkeeping) inside unrolled copies. The E-addendum's "outputs identical"
receipt predates F. Reproduce: a tsx probe with
`set_loop_unrolling_enabled(true)` building
`bench/nomen/mandelbrot.nm` with `{ arch: "aarch64", optimize: true }`.

Found while landing ASM_PLAN_3 tranche C (the array-pointer cache needed
per-copy clearing under index-constant unrolling — that fix is in
build_while_loop_node.ts and is unrelated to this corruption, which
reproduces with the array cache disabled via `set_array_licm_enabled(false)`).
Fix before ever enabling the unroller by default.

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

## Backend divergence: `string.to_string()` copies on C, borrows on aarch64 (FIXED)

Fixed by making `String.to_string` a real `mov out string` on BOTH backends:
the aarch64 raw body now strdups the ptr half (keeping the len half) instead
of returning the pair unchanged, so every backend hands back an independent
owned copy and the result can safely outlive its receiver. C was already
end-to-end sound (`strdup` body + callers free exactly once), so it needed no
changes.

Perf note: interpolated string args and `.to_string()` on strings now cost
one malloc+memcpy+free each on aarch64 (C always paid this). Identity-copy
elision remains possible future work if benches demand it.

## `KNOWN_HEAP_RETURNING` — dissolved (fixed)

Fixed by converting every registered function to a `mov out string`
signature, so ownership flows through parse (`returns_mov`) → the checker's
`owned_return` stamp → both backends' classification, instead of a hand-
maintained name list living in `scan_heap_returns.ts`. Converted:
`File.raw_read_all`/`raw_read_line`/`raw_read_chunk`, `Http.exchange`,
`Console.read_line`/`platform`, `Json.serialize`/`deserialize`,
`Regex.match`, and all nine primitive `*_to_string` builtins (int/uint/int8/
uint8/int64/uint64/float/bool/char — six further registry names,
`int16_to_string` etc., had referred to types that don't exist as structs
and were dead entries). `Directory_raw_list` was already stale and deleted.
`String.to_string` deliberately STAYS plain `out string`: it is the
identity/borrow (`string_to_string`), excluded from owned classification
everywhere. Supporting compiler changes:

- `function_returns_owned` classifies `mov out string` declarations as owned
  WITHOUT walking the body (raw `#arch` returns are invisible to the walk,
  which would otherwise see only a dead `return ""` fallback).
- aarch64 return-site normalization (literal-strdup + borrow-strdup) also
  fires for `mov out string` functions: the signature hands the caller an
  owned value, so every return path must produce heap storage (e.g.
  Regex.match's no-match path returning the empty literal).
- `build_function_call_node` (bare calls) and `is_owned_string_branch_value`
  (match/if joins) honor `owned_return`, not just set membership.

The set itself remains (now with no static seed) because it still accumulates
DYNAMIC entries: string-returning `spawn` callees (the trampoline frees via
Task.result's mov out contract) and functions whose return sites produce heap
values during building. The redundant-but-harmless `*_to_string` /
`_string_interpolate_` NAME patterns at call sites stay as defense in depth —
monomorphized call nodes can lose stamped annotations (the reason
`Buffer_string_move_T` is still name-matched despite `move_T` being declared
`mov out T`).

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

## NIR traffic deliberately does not count flow-arm / spawn-arg / nested-type reads

Landed with the fallback-retirement tranche (phase 4 canonical IR stage 2).
`from_ast` is now TOTAL: value-position `if`/`switch`/`match` lower to the
`flow` expr (arms riding the IR), value-position `spawn` to the `spawn` expr,
and nested type declarations to `opaque` — so every function publishes the
emission ctx and the whole-function AST fallback is gone (residual unknown
kinds are a tripwire throw).

For PROMOTION INPUTS, though, these keep their pre-tranche (barrier)
behavior: `traffic.ts` deliberately does NOT walk `flow` arms, `spawn`
arguments, or nested type-declaration bodies. Those shapes used to lower to
`other`/`opaque` barriers, and `plan_function_promotions`' inputs must stay
byte-stable (the same parity rule as assignment swap exprs). Affected
functions: the value-match cluster in `core/System/Controls/Container.nm`
(`length_kind`/`length_val` and friends) plus various concurrency/GUI tests —
none of them benchmark-hot.

When flipping traffic to count them (measure before/after per
ASM_PLAN discipline): walk the flow arms + spawn call facts like `cfg.ts`
already does (its folding is sound for liveness — no emission consumer). The
whitelisted pins live in `test/nir.test.ts` ("traffic deliberately does not
count flow-arm or spawn-arg reads").

## `int-cast + float` add emits `scvtf d0, d0` — FIXED (validator table gap)

`u.store_float(i, i as float + 1.0)` was rejected by the asm validator:
"'scvtf' operand shape mismatch: got reg,reg, expected f/r". The emitted
sequence (`fmov d0, x0; scvtf d0, d0; fmov x0, d0`) is CORRECT codegen —
move the int bits into d0, convert in place — and `SCVTF Dd, Dn` is a
valid hardware form (verified by assembling). The phase-1 validator's
mnemonic table simply lacked the f/f shape. Fixed in asm_ir.ts (tranche
D commit); the accumulator behavioral test now uses the original cast+add
source.
