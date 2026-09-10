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

## View-field structs in generic Lists (found updating the differator port, 2026-09-10)

The differator's `Line.text`-as-`view string` conversion (DIFF_TODO port
item 1) is blocked: the checker accepts a self-borrowed `List<VLine>`
return, but neither backend implements it.

**aarch64 silently corrupts.** Push/`at` round-trip of a struct with a
`view string` field through `List<T>` returns a wrong pair (len 2 reads
back as 1, pointer reads as empty). Reproduces with a single-field
struct too, and without any post-init field write — any view-field
struct in a `List` is affected. Direct (non-List) struct return of the
same value is correct, and a raw view local is correct, so the slice /
init / field-read paths are sound and the corruption is in the List
store/load (stride or pair-offset mismatch in the monomorphized
element). Silent wrong data — the worst shape for a diff library, which
is why the port keeps owned strings.

```nomen
import System

pub struct VLine {
	var view string text
	var start = 0
}

pub class Doc {
	var text = ""
	pub func lines = (ref self, out List<VLine>) {
		var List<VLine> result = List<VLine>()
		const n = self.text.length
		view txt = self.text.slice(0, n)
		if txt.length >= 2 {
			view first = txt.slice(0, 2)
			var l = VLine(first)
			l.start = 0
			result.push(move l)
		}
		return result
	}
}

pub func main = (Init init) {
	var d = Doc()
	d.text = "hi\n"
	const ls = d.lines()
	if ls.length == 1 {
		const line = ls.at(0)
		Console.write_line("len=\{line.text.length}")  // prints len=1, expect 2
		Console.write_line(line.text.to_string())      // prints empty, expect "hi"
	}
}
```

Same file, same binary: `view txt` alone prints `len=3 "hi\n"` and a
direct `out VLine` self-borrowed return prints `len=3 "hi\n"` — only the
`List` round-trip corrupts. Likely the same family as the
wide-struct-list-param gaps (`test/wide-struct-list-param-gaps.test.ts`).

**C backend rejects the same shape at compile time** (loud, at least):
the `out List<VLine>` method emits a bare `struct List` return type
(`incomplete result type 'struct List'`), and a view local passed to
`.slice` emits `string_slice(nomen_string, ...)` for a `nomen_view`
argument (`passing 'nomen_view' to parameter of incompatible type`).
So a view-field `List` return is currently unusable on both backends —
aarch64 miscompiles it, C won't compile it.

**Checker ergonomics on the same path** (minor, all in the repro
above): `self.text.slice(0, self.text.length)` and a guarded
`self.text.slice(0, 2)` behind `if self.text.length >= 2` are both
rejected (`Parameter constraint cannot be verified: end`) — bounds do
not propagate through `self.` field paths. Binding `const n =
self.text.length` first verifies. Also: `view x = <owned string>`
requires a `.slice()` result (a whole-field re-root needs a full-range
slice), and a struct with a view field has no zero-arg init
(`VLine()` → `Parameters missing for function: VLine`; construct as
`VLine(view)`).

## `nomen build --out` is ignored (found 2026-09-10)

`nomen build --in src/bench_one.nm --arch c --out build/bench_one_c`
prints `Built .../build/bench_one` and writes the binary there — `--out`
is silently ignored and whatever was at the default output path (here,
the fresh aarch64 `bench_one`) is overwritten. Not C-specific: `--out
build/bench_one_rel` on the default arch and `--out /tmp/cbench_test`
behave the same (output always lands at `build/<entry-basename>`,
nothing written to the requested path). Reproduced 4/4. Workaround:
build, then `cp` the binary aside before the next build.
