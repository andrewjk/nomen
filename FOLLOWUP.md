# Follow-ups

Skipped or out-of-scope items recorded for later.

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

## View argument to owned `string` parameter (deferred design question)

Passing a `view string` where an owned `string` parameter is expected is
allowed by omission (call-site type matching compares type names only) but
has no designed semantics, and the backends disagree: aarch64 silently
passes the pair through, C fails at clang (`passing 'nomen_view' to
parameter of incompatible type 'nomen_string'`). The differator works
around it by materializing (`.to_string()`) before such calls.

Probed for soundness holes on aarch64 (all correct output, `--audit`
clean, repeated runs): read-only callees, return passthrough (borrow
normalization strdup's), container stores (`store_T` strdup's), and
`move`-out into a return are all benign. Params are `const` (no
reassign-and-free), which closes the obvious hole. No crash, leak, or
wrong output constructed — so this is a coherence question, not a fire.

The two coherent options mirror the two precedents set elsewhere:
materialize at the boundary (what assignment/declaration/`return move`
now do — but a hidden malloc per call would reintroduce exactly the
per-line copies the differator just eliminated if it ever fires in a
loop), or reject at check time (what declaration Rule 3 does for
bindings — but that could break currently-passing aarch64 code; needs a
suite-wide audit first). Needs an owner decision; until then the backend
divergence stands (loud on C, silent alias on aarch64).

Also adjacent and known: `Console.write` uses `printf("%s")`, so printing
a mid-buffer (non-terminated) view over-reads to NUL. Callers materialize
first; length-aware `==` is unaffected.

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


## Allmark port blockers (found converting allmark's web impl to Nomen, 2026-09-10)

Converting the allmark markdown library (~170 TS files) to Nomen hit the
following. The port currently builds around all of these (traits instead of
func fields, `Map<string, int>` indices instead of reference-valued maps,
`--arch c` for the aarch64 mis-binds, no string-literal defaults on class
fields), but each should be fixed in the compiler:

1. **aarch64: class `#init` mis-binds scalar params after a string param.**
   `N1("c", 7)` with `#init = (ref self, string k, int i)` produced
   `self.idx == 1` (reads slot garbage) — the int lands in the wrong
   register/slot when marshalling a fat-string pair in front of it. The C
   backend is correct, so the allmark port targets `--arch c`.

   ```
   class N1 {
       var string kind
       var int idx
       pub func #init = (ref self, string k, int i) { self.kind = k; self.idx = i }
   }
   var n = N1("c", 7)
   // n.idx == 7 on --arch c, == 1 on aarch64
   ```

2. **aarch64: struct custom `#init` with two string params segfaults.**
   `S2("http://x", "t")` aborts (reads through a wrong pointer when the
   second string field is later read). C backend correct.

3. **Class string field with a literal default frees static rodata.**
   `pub var string content = ""` on a class emits `self->content =
   nomen_str_lit("", 0)` in `#init` — and any later `#init` assignment does
   `free(self->content.ptr)` on the static literal first, or destroy frees
   it at scope exit → "pointer being freed was not allocated" abort. Value
   structs are unaffected (their defaults are dup'd). Workaround: no
   default; `#init` sets `self.content = "" + ""` (a real allocation).

4. **`Map` values must be scalars or strings — struct/class/trait values
   are broken.** With `Map<string, SomeStruct>` the C backend emits
   `used type 'struct SomeStruct' where arithmetic or pointer type is
   required` (values are marshalled through 8-byte slots); aarch64
   segfaults. Class/trait values hit the same slot-marshalling. Workaround:
   `Map<string, int>` index into a parallel `List<T>`. (Docs should state
   the value-type restriction until fixed.)

5. **`Map` variadic constructor with class/trait values errors inside the
   library.** `Map<string, Animal>(["d", Dog()])` → "Cannot move a borrowed
   value into owning parameter 'value'" raised from `Map.#init`'s own body
   (the pair elements are loads, and `set` wants `move TV`). Same
   restriction as (4).

6. **Generic instantiation with a trait type arg fails under explicit
   annotation.** `var List<Animal> l = List<Animal>()` → "struct fields
   cannot be trait types" (the annotated-local check fires before the
   ClassBuffer rewrite). Inference (`var l = List<Animal>()`) and class
   fields typed `List<Animal>` work, so the trait-ClassBuffer routing
   exists — the annotation path just skips it.

7. **Func-typed struct fields are parsed but not callable.** `pub var func
   (int, out bool) test` inside a struct compiles, but `r.test(5)` →
   "Function not found: Rule.test" (and the same for a local copy `var func
   (int, out bool) g = r.test`). Either implement calling through
   function-typed fields or reject the field declaration with a
   "use a trait instead" error.

8. **Methods cannot return borrowed class refs.** `pub func node = (self,
   int i, out Node) { return self.nodes.at_or_panic(i) }` → "cannot return
   a borrowed reference". Callers must inline `state.nodes.at_or_panic(i)`
   instead. A sanctioned accessor shape (or `view`-like borrow return)
   would remove a lot of noise.

9. **Constraint-verification gaps at literal/length arithmetic:**
   - `"abc".slice(1, 3)` → "Parameter constraint cannot be verified" (the
     literal's compile-time length isn't recorded for the slice
     constraint); binding the literal to a `const` first works.
   - `l.at(l.length - 1)` under a `l.length > 0` guard → unverifiable
     (`length - 1 < length` needs arithmetic reasoning). List now gets
     `at_or_panic`, so callers sidestep it, but the common "last element"
     shape would be nice to prove.

## C backend: `Map<string, string>` rehash emits trait destroy calls

When a program contains BOTH a `Map<string, string>` that grows past its
initial capacity (triggering `rehash`) AND a `List<SomeTrait>`, the
`Map_string_string_rehash` auto-free block emits `SomeTrait_destroy(v);
free(v);` for the string values — `passing 'nomen_string' to parameter of
incompatible type 'void *'` compile errors. Reproduced minimal:

```
trait Rule { pub func name = (self, out string) }
class TextRule : Rule { pub func name = (self, out string) { return "text" } }

pub func main = (Init init) {
    var rules = List<Rule>()
    rules.push(TextRule())
    var m = Map<string, string>()
    m.set("a", "1")  // ... seven sets to force a rehash
}
```

The allmark port works around it by storing its 2125-entry HTML entity
table as fixed-width static string blobs with a hand-written binary search
(no Map at all). Two smaller C-backend issues found the same day, worked
around in the port:

- Assigning `null` to a `string?` class field (field default `= null` or
  `#init` assignment) emits `self->field = 0;` where the field is a
  `nomen_string` struct → invalid C. Workaround: initialize with `"" + ""`.
- `contains(node.field, "x")` directly in a `switch`/`if` condition emits
  the `_param_N` temp after its use (`use of undeclared identifier`).
  Workaround: hoist the field into a local first.
- Reassigning a class-typed local from `at_or_panic` a second time emits
  `_alias_owns_<name> = 1` without a declaration (name-mangled only on
  first assignment). Workaround: use fresh local names per re-fetch.

## C backend: trait-typed List monos poison `trait_class_locals` for all later monos

`trait_class_locals` (build_c/build_declaration_node.ts) is keyed by bare
local name and never cleared between function bodies. When a
`List<SomeTrait>` is instantiated, the emitted `<List>_copy` body declares a
local `v` (core List.nm's `copy`), which records
`trait_class_locals["v"] = "SomeTrait"`. Every LATER monomorphized body with
a local named `v` (e.g. `List_string_copy`, `List_int_copy` from by-value
List params) then auto-frees its element via `SomeTrait_destroy(v); free(v);`
— invalid C (`passing 'nomen_string' to parameter of incompatible type
'void *'`). Minimal repro (declaration order matters — the trait list must
come first):

```
trait Rule {
    pub func name = (self, out string)
}
class TextRule : Rule {
    pub func name = (self, out string) { return "text" }
}
class Holder {
    pub var List<Rule> rules = List<Rule>()
    pub var List<string> names = List<string>()
    pub func #init = (ref self) {}
}

pub func main = (Init init) {
    var h = Holder()
    h.rules.push(TextRule())
    h.names.push("x")
    Console.write("\{h.names.at_or_panic(0)}\n")   // C error at List_string_copy
}
```

Fix: clear (or scope/qualify) trait_class_locals per function body — or key
it by (function, name). This blocks the allmark nomen port's test suite: the
port's RuleSet/RendererSet legitimately hold trait lists, and List<string>/
List<int> are used throughout (found 2026-09-11; port builds clean under
`nomen check`, fails only in C emission).

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

## String literal escapes: `\\X` runs and `\{` make backslashes hazardous

The escape scanner processes `\` + next-char naively, so writing a literal
backslash as `\\` is fragile:
- `"\\{"` (escaped backslash, then a brace) starts INTERPOLATION — the
  scanner appears to look for `\{` without honoring the preceding `\\`, so
  `"\\{code}"` evaluates `{code}` as an expression.
- `"\\[x]"` errors: after consuming `\\`, the following `\[` is treated as an
  (unsupported) escape → `Unknown value: \` at the `[`.
- There is no `\`` escape — emitting `\\`` for a literal backtick yields a
  spurious backslash.

Workaround (used by the allmark nomen tests and already the convention in
Json.nm): always write literal backslashes as `\x5c` and leave `[`, `{`,
backtick etc. bare. A left-to-right escape decoder that honors `\\` as a
pair (or simply documenting `\\` as unsafe) would prevent this class of bug.

Also: interpolations containing escaped quotes directly before `\{`
(`" start=\"\{n}\""`) mis-tokenize catastrophically (the render-agent hit
this; reworked to string concatenation).
