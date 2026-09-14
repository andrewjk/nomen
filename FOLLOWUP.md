# Follow-ups

Skipped or out-of-scope items recorded for later.

## Enum-with-string-payload ownership edges

The core contract now works end to end on both backends (case construction
strdups string args; enum locals free payloads at scope exit; match hoists
call scrutinees into owned temps and frees them; reassignment frees the
displaced payload).

FIXED (2026-09-14): **storing a borrowed class value into an OWNING class
field** is now a check-time rejection (`cannot store 'b' into owning field
'art' — the field takes ownership of a borrowed value; take a fresh
instance, declare the parameter 'move', or pass it with 'move'`,
check_assignment_node). The rule fires only for genuine borrows — a
non-`move` parameter (resolved via the enclosing FunctionNode's params,
since a `move` param parses with declaration "var" + `ParameterNode.is_moved`),
a field/container borrow (`borrowed_from`), or an object alias
(`class_alias_of`). Owner-carrying values stay legal: fresh
constructors/call results, an explicit `move`, a `move`-param mutator
(`self.art = a`), and an owned local implicitly transferred
(`var TreeNode l = create_tree(...); node.left = l` — the backends already
move the local into the field; that idiom is all over the bench corpus).
`null` into a nullable owning field stays legal. Covered by
test/owning_field_borrow.test.ts (the borrowed shape double-freed on both
backends — aarch64 SIGSEGV verified before the fix).

Still open, with today's probe evidence:

- **Enum values stored INSIDE structs are not usable end to end — and not
  just for ownership.** `struct Holder { var Maybe m }` with
  `enum Maybe { case some(string) case none }`: `match h.m { case .some(v)
-> v }` binds an EMPTY/`(null)` payload even when the Holder is
  constructed INLINE (aarch64 verified; the LOCAL enum `var Maybe m =
Maybe.some("x")` matches fine, so it's the field-scrutinee path reading
  the payload pair at the wrong offset). Independent of that, the LEAK
  half stands: `<Struct>_destroy` (both backends) does not walk enum
  fields' string payloads (LEAK: 1 verified through a `make() -> Holder`
  boundary). Fixing the destroy walk alone won't make the shape usable —
  the field-scrutinee binding needs its own investigation.
- **Enums as generic-container element types are broken earlier still**:
  `List<Maybe>`/`Buffer<Maybe>` on C fails at header emission ("unknown
  type name 'Maybe'" — the `Buffer_Maybe_*` prototypes precede the enum
  typedef), so the container element-payload walk can't even be evaluated
  on C until that ordering is fixed. aarch64 runs `List<Maybe>` +
  push/length under audit clean (payloads may be stored raw rather than
  strdup'd — unverified which).
- **Enum-valued struct FIELD returns** (`return self.last_result`)
  bitwise-copy the payload without a boundary copy — aliasing with the
  field's own lifetime is unchecked. (The `make() -> Holder` probe also
  showed the payload not surviving to the match, so the by-value struct
  return of an enum-carrying struct needs verification on both backends
  once the field-scrutinee bug is fixed.)
- **A match binding that escapes its branch** (`case .ok(t) -> return t`)
  relies on the return-boundary borrow normalization; deeper escapes
  (storing the binding) are untracked.

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

## `buffer_pipeline.ts` (ASM_PLAN_3 tranche K) is dead code

Found while landing ASM_PLAN_7 tranche 3: the inline Buffer address
pipeline never runs. `pipeline_on` initializes `false` and nothing in
`src/` ever calls `set_buffer_pipeline_enabled(true)` — every
`tryHoistBufferAddrs` invocation returns at the enable check
(`NOMEN_PIPE_DBG=1` shows the `tryHoist` line and nothing else). The
receiver data-pointer hoisting the pipeline was written for is actually
performed by the region brackets (`region_pool.ts`, ASM_PLAN_5+) and the
emit-time fallback added in tranche 3. Two consequences for the remaining
ASM_PLAN_7 tranches:

- Tranche 4 (constant rematerialization) and tranche 5 (stack-staging
  elision) descriptions reference pipeline-adjacent behavior
  (`buffer_base_cache` is likewise only ever populated by the dead
  pipeline) — read those as "the region-bracket equivalents".
- Either delete `buffer_pipeline.ts` + its BuildStatus fields, or wire
  the enable switch, before it misleads another tranche.

## View argument to owned `string` parameter (RESOLVED: reject at check time)

RESOLVED (2026-09-14): passing a `view string` where an owned `string`
parameter is expected is now a check-time rejection —
`cannot pass a 'view string' to string parameter 's' — call .to_string()
to materialize an owned copy` (check_function_call). The owner decision was
"reject, require explicit `.to_string()`", matching declaration Rule 3's
posture rather than inserting a hidden malloc at every call boundary (the
materialize-at-boundary option would reintroduce the per-line copies the
differator just eliminated). Rejection covers free functions, methods, and
constructor field arguments; the reverse direction (owned `string` →
`view string` param) remains the supported implicit borrow, and the other
boundaries (assignment / declaration / `return move`) still materialize by
design. The suite-wide audit was clean — nothing in the corpus relied on
the silent coercion (as expected: it never compiled on C). Covered by
test/view_to_owned_string.test.ts.

Adjacent and still known: `Console.write` uses `printf("%s")`, so printing
a mid-buffer (non-terminated) `view string` over-reads to NUL. The new
rejection removes the bare-view call path (callers must materialize, which
NUL-terminates), but any raw/FFI bridge that hands a non-terminated view's
`char*` to `strlen`-based code retains the hazard — see "Residual
string-byte hazards" below. Length-aware `==` is unaffected.

## Element iteration for remaining collections (split out of for-of-List)

`for x of some_list` desugars to element iteration for `Array<T>` and now
`List<T>`, but the other collections can't follow yet:

- `Graph<T>` has no `length` at all (the `Enumerable` default returns 0),
  so desugaring via `0..length` would silently produce empty loops.
- `LinkedList<T>`/`Tree<T>` have `length()` methods, but their `.at`
  contracts are phrased against `count` (`idx < self.count`), and a
  `0..length()` range does not discharge that today (verified failing on
  0.2.2) — needs either field-based lengths or return-contract linkage
  from `length()` to the count field.
- `Map`/`Set`/`Buffer` have no `.at(i)` element semantics to desugar to.

Also still open from the same area: `for ref x of list` is rejected with
a dedicated error (List `set` takes `move T`, so the array writeback
shape doesn't transfer — needs its own design).

Converting the allmark markdown library (~170 TS files) to Nomen hit the
following. The port currently builds around all of these (traits instead of
func fields, `Map<string, int>` indices instead of reference-valued maps,
`--arch c` for the aarch64 mis-binds, no string-literal defaults on class
fields), but each should be fixed in the compiler:

## Map values are fully supported (allmark PORT "Map values must be scalars or strings") — RESOLVED

RESOLVED (2026-09-14): `Map` values of every kind work via `Map()` + `set()`
— scalars/strings as before; class and trait values (after the
reference-value routing fixes: `swap Buffer<TV>()` in Map.rehash and Map's
`alloc_T` forwards now lower to `ClassBuffer` for class/trait elements,
which gained `alloc_T` for generic parity); and VALUE STRUCTS, including
allmark's `LinkReference` shape (a struct of strings). `set` / `get_or` /
`has` / `length` and overwrite-of-an-existing-key all run correctly on both
backends under audit — covered by test/map_reference_values.test.ts. The
allmark port's `Map<string, int>` + parallel `List<T>` workaround can
collapse back to `Map<string, LinkReference>` /
`Map<string, FootnoteReference>` (those tables are lookup-only — no map
iteration is needed, and none exists).

What remains is the VARIADIC PAIRS CONSTRUCTOR form only:
`Map<string, Animal>(["a", Dog()])`.

- **Class/trait TVs are gated at check time** (`variadic_init_unsupported`):
  the pair tuple materializes as a value struct with a trait/class-typed
  field (rejected for the byte-copy double-free reason), and the body's
  borrowed pair element can't feed a `move TV` param soundly. Lifting the
  gate needs the ownership work from the 2026-09-11 design discussion:
  classify trait fields like class fields in `is_owning_struct_*`, allow
  class/trait fields in value structs (owning aggregates, move-only
  assignment), and allow borrowed → move when the source field's container
  doesn't destroy it (with the field invalidated against re-read).
- **Value-struct TVs are NOT gated and crash on aarch64** (found
  2026-09-14): `Map<string, TV>(["a", TV(1)])` for ANY value struct TV
  (two ints, one string, one int all reproduced) builds, and the C backend
  runs it correctly, but aarch64 SIGSEGVs — `Tuple_<TK>_<TV>_init` reads a
  null struct argument (`ldr x9, [x3]` with `x3 = 0`), i.e. the variadic
  pair packing does not materialize/pass the value-struct tuple element's
  address. Fix direction: either extend `variadic_init_unsupported` to
  value-struct TVs (a consistent clean rejection, at the cost of the
  working C shape) or fix the aarch64 variadic tuple packing.

## CLI: `nomen test` build phase runs out of memory (OOM) on the allmark project

`nomen check --in test/<file>.test.nm` completes in ~6s (12k warnings, 0
errors) on the allmark port, but `nomen test --arch c -f <filter>` — which
parses, checks AND builds the same joined source — dies with
"Ineffective mark-compacts near heap limit" after ~19s and 4 GB (also with
`NODE_OPTIONS=--max-old-space-size=8192`, so it is an allocation loop, not
just a large workload). Even a single-function test file
(`t.expect(true, "tiny")`) OOMs, so the trigger is in the joined src module
or the harness/build path, not in test volume. `nomen run --arch c` on the
same project reaches C emission without OOM (it fails on the
trait_class_locals bug above), so the difference is the test path:
`strip_main_functions` + the generated harness + build. Worth profiling
`run_test_file`'s build phase on this corpus.

## Residual string-byte hazards (narrowed from the Utf8-found set)

The three hazards found while testing System.Text.Utf8 are fixed and
covered (test/string_bytes.test.ts; `0x0` restored in test/utf8.test.ts):
the aarch64 const-fold no longer folds escape-containing literals
(`resolve_string_op` bails to runtime concat), `string_literal_length`
does UTF-8 width math plus octal escapes, and StringBuilder's raw C
bodies are natively fat (NATIVELY_FAT_PREFIXES) so embedded NULs survive
`to_string`/`append_string` on C. What remains:

- **Source-level hex escapes are emitted into C verbatim** (found
  compiling the allmark port's 2125-entry entity table, whose literals
  are full of `\x01` separators): `escape_c_string` (build_value_node)
  intentionally leaves source escapes untouched, so `"\x01AMP"` reaches
  C as `"\x01AMP"` — C's `\x` consumes ALL following hex digits
  (`\x01A` = 0x1A, longer runs exceed 255) and clang rejects the TU with
  `hex escape sequence out of range`. Fix direction: when emitting a
  string literal that contains a `\x` escape (or any byte-level escape),
  either re-encode those escapes with exactly-two-digit form split from
  adjacent hex-digit characters (`"\x01" "AMP"`), or emit them as octal
  (`\001`, self-terminating). The same greed applies to octal escapes
  followed by a `0`–`7` digit.
- **General NUL beyond StringBuilder.** The thin raw-string adapter still
  synthesizes length via `strlen`, so any OTHER raw-C function returning
  bytes with embedded NULs (File reads, FFI) truncates the same way.
  Fixing each means fat-aware authoring + exemption per function, as done
  for StringBuilder — or a length-carrying adapter protocol (big blast
  radius; needs an owner decision).
- **`\8`/`\9` and `\x`-with-no-digits are degenerate.** Octal handling
  covers `\0`–`\7`; `\8`/`\9`/bare `\x` keep the old pair-counting while
  clang/GAS do whatever they do (clang warns). Nobody writes these, but a
  check-time rejection would be more honest than silent divergence.

## Cross-scope string field stores leak the stored copy (accepted, bounded)

The dangling half of this is FIXED. Assigning a heap-owned string local into
a struct field through a `ref` struct parameter used to raw-store the local's
(ptr, len) and then reclaim the buffer at the local's scope exit — the field
dangled the moment the callee returned (C was correct; it strdups). The
aarch64 backend now strdups the pair at the store and records the field as
heap (mirroring C), so the field owns an independent copy and the local's own
free stays sound. Covered by test/ref_param_string_field.test.ts.

What remains — and was already true before the fix — is a LEAK for every
cross-scope owning store, because `heap_string_fields` records are
scope-local: the record that "this field holds heap" lands in the CALLEE's
scope and dies at return, while the field lives in the CALLER's variable,
whose scope exit never frees it.

- `dst.s = <fresh call result>` (e.g. Regex.find's
  `dst.text = input.substring(...)`) — transferred raw; the buffer leaks.
  Pre-existing; invisible until audited because the covering tests ran with
  audit off.
- `dst.s = <heap-owned local>` — the strdup'd copy leaks (new since the
  dangle fix; strictly better than the corruption it replaces).
- Repeated stores free each displaced copy (`old_was_heap`); only the final
  value leaks, so the leak is bounded by fields, not stores.
- Same-scope stores (`b.s = s` where `b` is the local being stored into) and
  class fields are fully balanced — the record (or the class destroy) frees
  at the owner's scope exit. test/ref_param_string_field.test.ts asserts the
  same-scope shape with audit ON and the cross-scope shapes with audit OFF
  (they report `LEAK: 1 allocation(s)` by design).

Posture: leak, never double-free/invalid-free — the same trade
`drop_self_written_string_field_records` makes for displaced `self`-writes.

Fix directions, when picked up (either closes the leak class):

1. **Caller-side record propagation.** At each direct call `fill(ref b)`,
   scan the callee (transitively, like `scan_self_string_field_writes`) for
   writes to its ref params' string fields, then add/refresh the caller's
   `b.s` record so the owner's scope exit frees. Soundness needs
   must-executed (dominator) + always-heap analysis: a record over a field a
   not-taken store left holding a borrow would free rodata at exit. Shapes
   that can't be proven keep the leak.
2. **Always-heap value-struct string fields** (tier 3 in the trait-dispatch
   entry above): strdup on every assignment including literals,
   `<Struct>_destroy` frees every field. Deletes `heap_string_fields` and
   this whole class; costs a malloc per literal store into a value struct.

## Constructor field-override (`[ .. <base>, ... ]`) defects

Found while verifying the allmark port's "struct literals / builders" ask.
The base-seeded literal `[ .. <base>, field = value, ... ]` (which replaced
the retired `T() + [ ... ]` syntax) is sound on both backends for scalar
defaulted fields — constructor, factory, and variable bases — but:

- **`Array<T>`/`List<T>`-typed fields cannot have default values.** A field
  like `var Array<int> children = Array<int>()` emits `_self.children = {};`
  on C (clang rejects it: "expected expression") and segfaults the aarch64
  binary at runtime. Defaults are therefore limited to scalar-typed fields
  today, which blocks the one-expression-factory pattern for any node struct
  carrying a children list.
- **Override RHS is evaluated after the base lands in the destination.** In
  `m = [ .. x, node_type = m.node_type ]` the override expression reads the
  destination's post-copy value: both backends copy the base into the target
  (or run `#init`) BEFORE evaluating the `[ ... ]` values, so a self-reference
  silently yields the new/clobbered value instead of the pre-assignment one.
  No error, just a wrong value. Workaround: copy to a temp first
  (`var string saved = m.node_type`). Fix direction: evaluate override value
  expressions into temporaries before emitting the base copy/init.
- **Override values' reads are invisible to NIR traffic/liveness.** The
  lowering keeps the base's reads (via the wrap expr) but the `[ ... ]`
  field expressions ride the node (same exposure the `+` form had). Only
  matters if an override value reads something whose last use is the
  override itself; promotion would then conservatively keep it in memory —
  sound, just not optimal.

## AARCH64 inline splices: bodies with calls are refused, root miscompile unsolved

Auto method inline (ASM_PLAN_7 tranche 7) ships default ON but LEAF-ONLY
(`is_auto_inline_method` in `scan_inline_candidates.ts`: no calls, no
T-generic callees, struct receivers, <=3 statements/params; measured
spectral-norm -53%, knucleotide -26%, neutral elsewhere), and the
user-marked `inline` dispatch is gated by the same refusal
(`inline_method_splice_unsafe`); refused methods get standalone bodies
(`build_struct_node`) so their call sites take the real call.

**Investigation state (2026-09-14 session — reproducible in minutes):**

- Repro: mark ONE `JsonTree` setter `pub inline`
  (`core/System/Text/JsonTree.nm`) + disable
  `inline_method_splice_unsafe` (return false) + run
  `npm test test/json.test.ts` — the 3 parse tests fail (SIGSEGV /
  wrong tree). Gate ON: all green.
- Per-method bisection (one method marked at a time): splicing
  `set_child` (field write at node offset 32) or the getters PASSES;
  **splicing `set_kind` alone (field write at offset 8) fails** —
  output shows node0.child = 0 and node0.val = 0 (should be 1 / -1)
  plus 1 leaked allocation. The leaked node + zeroed fields say the
  spliced body's nested `load_T` copied from ZEROED memory (a fresh
  calloc region), and the store wrote that zeroed node back.
- The nested raw bodies (load_T/store_T) index correctly (stride 56 =
  raw_type_size(JsonNode), slab sized by grow_T's T_SIZE — verified in
  the generated asm) and the arg parks read the right registers at the
  set_kind site. So the wrong bytes come from the load's SOURCE
  address or a lost data-pointer reload — not from sizing or parks.
- Disproven this session: x23-x28 preservation at the splice boundary
  (unconditional push/pop of the caller's pool regs in
  build_inline_method) was implemented and did NOT change the
  set_kind-only failure — reverted (no confirmed clobber vector; bench
  cost unmeasured).

Next step: in the set_kind-only failing build, watchpoint
`node0.child` (slab + 32) through the parse and log every writing PC
(lldb `watchpoint set expression -w write -s 8 -- <data+32>` at the
first json_parse_pairs stop; the watch itself worked — capture the
command output with `watchpoint command add`). The first write of 0
names the miscompiled store directly.

## Generic enum return from a generic-struct method fails to monomorphize (found building `Arena<T>`)

A method whose body returns a generic enum over the struct's own type
parameter does not monomorphize: adding

```
pub func try_get = (self, ArenaRef<T> handle, out Option<T>) {
    if !self.is_valid(handle) {
        var Option<T> none = Option<T>.none
        return none
    }
    return Option<T>.some(self.values.load_T(handle.index))
}
```

to `core/System/Arena.nm` compiles through the checker but the C backend
emits `Option Arena_string_try_get(...)` — the bare, un-instantiated
`Option` typedef — and `_some(&Option, ...)`, so clang rejects the TU
("unknown type name 'Option'"). The method was dropped from `Arena<T>` in
favor of `is_valid` + `get_or` + `get` (which cover the same cases without
a generic-enum return). Repro: add that method back and build any
`Arena<X>` program on the C backend. Likely the same class of gap as other
"generic value produced inside a generic method body needs
instantiation" sites (cf. the `List<int>`-as-generic-struct-field case:
`List<int>` there also fails with "Function not found: List_int");
worth a general pass over monomorphization of generic types mentioned
only inside generic bodies.
