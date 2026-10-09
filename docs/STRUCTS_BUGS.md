# BUGS.md

Pre-existing compiler bugs found (and fixed) while implementing the struct
plan's Phase A (see [`docs/STRUCTS.md`](./docs/STRUCTS.md)). Recorded so the
fixes survive a plan rollback: if Phase A is reverted, these are real bugs on
`main` independent of the plan, with their fixes described here.

## 1. Prefix-`mv` declarations never transfer (checker gap)

**Seen on `main` (commit 11a7090b), both backends' checker.**

The `mv T r = src` **declaration prefix** never stamps the initializer as an
ownership transfer — `decl.value.is_moved` is only set by the _expression_
`mv` prefix (`mv T r = mv src`, parsed in `src/parse/parse_expression.ts`),
never by the declaration keyword (`src/parse/parse_declaration.ts`). Every
downstream transfer rule keys on `decl.value.is_moved`
(`src/check/check_declaration_node.ts`), so the prefix form misbehaves in two
ways:

- **Class source — silently aliases instead of transferring.**
  `mv Box r = p` sets `class_alias_of` on `r` (the historical lenient-alias
  path): `p` stays usable, both names share the instance, and the instance is
  destroyed once via `p`'s slot. The documented transfer semantics ("`mv Box
q = p` — transfer; p is invalid afterwards") never happen; only
  `mv Box r = mv p` actually transfers.
- **Owning value-struct source — false "cannot copy" error.**
  `mv H q = p` (H mv, e.g. a `List` field) hits the
  `cannot copy 'H' by value — it owns heap resources; use .copy() or mv`
  error _even though `mv` was written_ — the prescribed fix is
  unsatisfiable in the prefix form. Repro (errors on `main`):
  ```nomen
  import System
  struct H { mv List<int> items }
  pub func main = () {
      var H p = H(List<int>())
      mv H q = p
      Console.write("\{q.items.length}\n")
  }
  ```

**Fix:** in `check_declaration_node`, when `declaration === "mv"` and the
initializer is a bare variable (`decl.value?.node_type === "value"`) without a
swap and not already `is_moved`, stamp `decl.value.is_moved = true` before the
ownership checks. Everything downstream then behaves: the mv-struct
"cannot copy" gate is satisfied, the source lands in `moved_variables`
("used after move" on later uses), both backends' alias classification
(C `val_is_class_alias`, aarch64 `value_is_var_borrow` — both require
`!is_moved`) treat the binding as owned, and the transfer destroy/frees
exactly once. The swap form (`mv x = a swap b`) is deliberately left on its
pre-existing path (the transfer arm at the `!decl.swap` gate never owned that
shape).

## 2. Move-through-a-`ref` reported with the wrong message (Phase A arm starved by bug 1)

STRUCT_PLAN_3 §A3.3 (new checker code, but starved by bug 1): `mv Box r = q`
where `q` is a `ref` binding must error
`'q' is a ref — mv the owner instead`. Because the prefix `mv` never set
`decl.value.is_moved`, the §A3.3 arm (gated on `decl.value.is_moved`) never
ran, and the _unspelled-alias_ error fired instead. Fixing bug 1 routes the
prefix form into the §A3.3 arm and the right message comes out. Only visible
with Phase A's `ref` bindings; listed because the fix is the same stamp.

## 3. aarch64: a class TRANSFER declaration destroys the shared instance twice

**Seen on `main` (commit 11a7090b), aarch64 backend only — C is correct.**

`var Box r = mv p` (and, after bug 1's fix, the prefix form
`mv Box r = p`) ran the instance's `#destroy` **twice** at scope exit on
aarch64. Repro (prints `DD` on aarch64, `D` on C):

```nomen
import System
class Box {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
pub func main = () {
	var Box p = Box(1)
	mv Box r = mv p
	Console.write("\{r.v}\n")
}
```

Root cause: the aarch64 declaration path classifies a bare-class-source
initializer as an alias via `value_is_var_borrow`, which required
`!(node.value).is_moved` — so a moved source made the NEW binding an owner
(pushed onto `scoped_declarations`). But the instance's allocation stays
anchored in the SOURCE's heap slot (anchors cannot follow the new binding),
and the source `p` also remains in `scoped_declarations` — scope exit walked
both declarations against the same pointer: `Box_destroy(p); Box_destroy(r)`
(the free itself still fired once, via p's anchor slot, so this corrupted
destructor state rather than the heap — worse in its own way). The C backend
classifies the same shape with `val_is_class_alias`, which deliberately does
NOT consult `is_moved` for a bare class source: `r` stays a non-mv alias,
`p`'s slot is the single owner, and teardown runs exactly once.

**Fix:** drop the `!is_moved` condition from `value_is_var_borrow`
(`src/build_aarch64/build_declaration_node.ts`) so a moved bare class source
classifies exactly like C — the new binding is an alias, the source's anchor
slot owns, teardown is single. Checker-level transfer semantics (the moved
source is unusable afterwards) are unchanged; they live in the checker's
`moved_variables`, which both backends share.

## 4. `ref Box q = <fresh value>` was silently accepted (Phase A checker gap)

Not on `main` (the `ref` keyword is Phase A work), but a hole in the Phase A
checker as first written: the "ref requires an existing binding" error only
fired for bare `value`-node initializers, so `ref Box q = make()` and
`ref Box q = Box(1)` (fresh owned values — nothing to alias) passed the check
and then built as owned storage: `ref` spelled, `var` semantics. Fix: fire the
error for ANY initializer that `ref_alias_source_name` cannot classify as an
existing binding/field/borrow-returning call (§A1). `ref q = mv p` also
errors now (an alias never takes ownership).

## 5. A root-scope class global is unreadable from any other function (both backends)

**Seen on `main` (commit 11a7090b), both backends.** A class-typed global
(`var Box g = Box(5)` at root scope) was compiled as a MAIN-LOCAL, not a
module-scope global — any other function referencing it failed to compile:

- **aarch64**: the root scan collects non-literal root `var`s into
  `module_init_statements` and splices them into main's prologue ("a
  class-typed root declaration cannot even be BUILT — its storage anchor
  assumes a stack frame", build_block_node). The declaration therefore took
  the in-function storage branch (`function_return_label` set) and got a MAIN
  FRAME SLOT, while every other function's `emit_var_load` fell back to the
  `adr <reg>, g` SYMBOL form → `Undefined symbols for architecture arm64: g`
  at link time. Repro:
  ```nomen
  import System
  class Box { var int v }
  var Box g = Box(5)
  func readg = (out int) {
      return g.v
  }
  pub func main = () {
      Console.write_line("\{readg()}")
  }
  ```
- **C**: the root declaration was emitted as a main-local
  `struct Box *g = Box_init(5L);` and NEVER at file scope, so other
  functions' references were `use of undeclared identifier 'g'`.

This mechanism is almost certainly what the (never-reproduced) FOLLOWUP
report "root-scope `ref` — Undefined symbols for architecture arm64: q"
described: a root-scope alias read from a non-main function hits exactly this
(aarch64 and C both now handle it — verified `ref Box q = p` at root + read
from a function).

**Fix:** the declaration keeps MODULE-scope storage regardless of the
prologue's build context. aarch64: the root scan stamps collected declares
`is_module_init`; build_declaration_node's class branch emits a `.data`-section
symbol (`g: .space 8` wrapped in `.data`/`.text` switches — the output is one
`__TEXT` stream where stores fault, the same pattern as the vtable emission)
and the prologue stores through `emit_var_store`'s symbol path. C: the root
scan emits `struct Box *g = (void *)0;` into the header preamble (ahead of
every function) and the spliced prologue emission becomes the initializer
assignment. Value-struct globals took the same shape in Phase R tranche 3
(the mv-struct declaration arm emits file-scope storage; the prologue
assignment runs the constructor through `&name`). Trait-typed globals were
closed later: the root scan emits `void *g = (void *)0;` at file scope, the
prologue emission assigns the boxed handle, and the handle's trait binding
is recorded in a body-global map (`trait_class_globals` — the per-body
`trait_class_frames` / `class_vars` do not carry across functions) so
dispatch from any function passes the handle by value instead of taking its
address. Covered by `test/root_scope_trait_global.test.ts`.

## 9. aarch64: an enum-with-data payload of a value struct crashes at the match binding

**FIXED 2026-10-05.** Seen on `main` (commit 11a7090b), aarch64 only — C was
correct. An enum with a value-struct case payload crashed at the `match`
binding (EXC_BAD_ACCESS in `_platform_memmove`):

```nomen
import System

struct Config {
	var string name
}

enum Holder {
	case some(Config c)
	case none
}

pub func main = () {
	var Holder h = Holder.some(Config("owned"))
	match h {
		case .some(c) -> Console.write_line("got \{c.name}")
		case .none -> Console.write_line("none")
	}
}
```

Root cause: the aarch64 enum-with-data machinery sized a case payload with
`aarch64_size(type.name)`, which knows only the built-in scalar widths and
returns **8** for any struct/enum name. A multi-word value-struct payload (or a
nested enum-with-data blob) was therefore:

- under-sized in the enum temp (`get_enum_size` summed 8 per payload), so the
  payload area was truncated;
- mis-offset for every payload after it (`get_enum_payload_offset` walked 8 per
  payload) and for inline payload-field access;
- STORED as a single `str x0` word by both case-constructor paths — a pointer
  to the argument's temporary (a struct's own bytes were never copied), and
  LOADED as a single `ldr` at the match binding — a partial value that crashed
  on the first field read.

Fix, sharing the layout authority:

- `get_enum_size` / `get_enum_payload_offset` size each payload with
  `get_type_size` (which resolves structs/enums/strings), so temp sizing and
  offsets are correct and consistent across construction, binding, field
  access, and destroy.
- New `emit_enum_payload_binding_load` (struct_layout.ts) copies a payload out
  of the blob: width-matched scalar/string-pair loads, and a word-by-word
  `emit_struct_copy` for multi-word value payloads.
- New `emit_enum_payload_arg_store` (build_access_node.ts) stores a payload
  arg: strdup for strings, `emit_address_of` + `emit_struct_copy` for
  multi-word value payloads (the bytes are copied, never a pointer), scalar
  stores otherwise. Both case-constructor paths (shorthand function call and
  access-function call) use it.
- Both constructor paths now compute per-arg payload offsets as a forward
  prefix sum (`get_type_size` per param) instead of a running accumulator over
  a reverse-order loop — the old accumulator put a differently-sized later
  payload at the wrong offset.
- The inline payload-field access path resolves its offset via
  `get_enum_payload_offset` and returns the ADDRESS of a multi-word value
  payload (a single word load returned a partial value). The nested-destroy
  offset walk now sizes non-struct fields with `get_type_size` too (an
  enum-with-data field had been counted as 8).

Regression coverage: `test/enum_byval_param.test.ts` —
`enum_struct_payload_match` (the repro), `enum_struct_payload_local`,
`enum_struct_then_scalar`, all on both backends. C was already correct and is
unchanged.

## 10. aarch64: a generic CLASS with an inline value-struct `T` field sizes `T` as one word

**FIXED 2026-10-05 (Phase B tranche 2 gap-fix).** A generic class whose
field is the type parameter INLINE (`class Box<T> { mv T __value }`)
computed its mono construction size from the BARE generic name: the aarch64
declaration path called `get_struct_size(node.type.name)` where
`node.type.name === "Box"` (type args carry the mono), so the layout sized
`T` as one word — `Box<Node>` (Node = 24 bytes inline) malloc'd 16 and the
auto-destroy walk read past the block (EXC_BAD_ACCESS in `Node_destroy`).
C was immune (its `sizeof(struct Box_Node)` comes from the mono typedef).

Fix: resolve the MONO name before sizing in the aarch64 class-construction
path (`mono_type_name(node.type)` → `Box_Node`), matching the C backend's
resolution. Two companion bugs in the same area were fixed for the
transparent `box.field` access: the field-chain builder must treat a chain
rooted at a `Box<T>` binding as a POINTER dereference (not inline-storage
offsets), and it must resolve the containing struct by the mono name (the
bare generic's field is still typed `T`).

Nothing before `Box` had an inline generic value-struct field in a CLASS —
List/Map/Set hold elements through `Buffer_<T>`/`ClassBuffer<T>` pointer
slots — so the aarch64 mono layout path was never exercised with one. The
Box runtime tests now run on BOTH backends.

## 6. `test_error` test helper spins forever on an out-of-range line

`test/test_error.ts`'s line-scan loop condition was
`i < source.length, l < line` — the comma operator discards the first
operand, so the loop ran on `l < line` alone. A test expecting an error at a
line beyond the source's line count never satisfied it: the worker spun at
100% CPU forever with no output (a wrong expectation looked like a hung
suite). Fix: `i < source.length && l < line`.

## 7. Spawning with a value-struct argument never compiled (aarch64) / never worked (both backends)

**Seen on `main` (commit 11a7090b).** `Thread(work(some_struct))` — any
value-struct argument — was broken on both backends, differently:

- **aarch64**: the companion's env/forward-declaration types came from
  `c_type(mono_name)` — the by-value TYPEDEF name (`P`), while the assembly
  staging passes ONE WORD (struct values travel by reference), so the
  companion failed to compile (`must use 'struct' tag to refer to type 'P'`,
  `a parameter list without types is only allowed in a function definition`).
  The code comment called it a "pre-existing limitation" — no struct arg
  could ever reach the env intact.
- **C**: the env field types and the trampoline's forward declaration used
  the GENERIC template name (`struct List *`) for a `List<int>` argument —
  the template is never emitted as a C struct (`sizeof(struct List)` =
  incomplete type), and the declaration conflicted with the callee's real
  mono signature (`long sum(struct List_int *)`). When the types happened to
  exist (a concrete struct like `P`), the env deep-copy was SHALLOW: only
  string fields are duplicated, so a container field shared its buffer and
  the env destructor freed the donor's live buffer (AUDIT-STALE-FREE).

**Fix (as part of N1a R1):** both packers classify every argument and share
one matrix — scalars by value; strings duplicated (+ env-destroyed);
class/trait args shared pointers (env owns nothing); value structs staged by
the donor's ADDRESS with env ownership chosen per context: a region-checked
BORROW inside `async { }` (the checker stamps `region_borrowed_args`), an
env-owned copy otherwise (malloc + pointee copy + string-field strdups,
env-free at teardown — sound for plain-data structs, which is all that can
reach it now, see the R1 checker rule). The C packer resolves struct types
through `mono_type_name` (`List_int`, not `List`).

## 8. A `ref` value-struct argument to a spawn was silently deep-copied

**Seen on `main` (commit 11a7090b), both backends.** `Thread(work(ref
counter))` where `counter` is a value struct: the env packed a COPY of the
struct, so the callee's `ref` parameter pointed at the copy — every mutation
through the ref was lost, and the donor never observed the callee's writes.
A `ref` parameter is a MUTABLE BORROW (the parameter table's contract); the
spawn boundary silently violated it.

**Fix (as part of N1a R1):** a `ref T` (T a value struct) argument inside an
`async { }` block is stamped a region-checked BORROW — the env passes the
donor's address, the root rule bounds the donor's scope, and the freeze keeps
the donor itself const while the callee mutates through the ref. Outside a
nursery the pack keeps the env copy (no join to bound a borrow — the same
posture as bare mv args).

## 11. Generic construction without call-site type args links against the generic's init

**Seen on `main` (commit 5e32d3e4), both backends.** A user generic struct
whose only constructor is the bodyless auto (field-based) `#init`, constructed
WITHOUT call-site type args — `var Holder<int> h = Holder(7)`, T recovered from
the annotation — emitted a call to `<Generic>_init` (`Holder_init`), a symbol
no backend ever emits (only the `<Generic_<T>>_init` monos exist). Link failed
on both backends (aarch64: `Undefined symbols … Holder_init, referenced from:
main.o`; C: the same undefined reference).

Root cause: `check_function_call_node`'s constructor resolution had three arms —
explicit call-site type args (renames the call to the mono), a generic struct
with a custom `#init` (infer-init-type-args, also renames), and a final `else`.
The final `else` found the generic struct's synthesized bodyless `#init` and
stamped `node.name = struct.name` (the bare generic), so the build emitted
`Holder_init`. Only the "no call-site args + bodyless auto-init" shape reached
it; the corpus always spelled the args or used a custom `#init`, so it never
hit the gap.

**Fix:** the generic case gets its own arm. When the struct is generic, the
call has no explicit type args, and the expected type (annotation, return type,
or parameter type) is the generic with a full set of concrete type args, the
call is monomorphized from those args and pointed at the mono's `#init` exactly
like the explicit-args arm (`node.name = target.name`, `node.type_args = …`).
If no concrete expected type is available (and the call is not inside a generic
body, which defers), it reports
`Cannot infer type arguments for <Generic> — spell them` instead of emitting the
unresolvable generic init call. Covered by
`test/owning_decl.test.ts` (`generic_inferred_ctor`), both backends.

## 12. aarch64: transparent `Box<T>` member access on a call result mis-lowers

**Seen on `main` (recorded 2026-10-06, B5/B6 tranche; aarch64 only — C was
correct).** A `Box<T>` value returned from a call — e.g. `list.at(i).v` or
`store.find(i).v` — read through transparent box access (`b.v` →
`b.__value.v`) crashed the aarch64 binary (SIGSEGV). It surfaced while
interpolating the member (`Console.write_line("\{s.get(1).value}")`), which is
why it was filed as "string interpolation of a nullable-box member"; the
interpolation itself lowered fine and the crash was in the member read.

Root cause: `build_access_node`'s method-call-result branch (`points.at(0).x`)
looked up the accessed field's declaration by the **bare** target type name
(`target_type.name`). For a generic target (`Box<Node>?`) that is `Box`, whose
field list is unsubstituted — the `__value` hop resolved to the type parameter
`T`, not the concrete `Node`, so it fell down the scalar path and loaded the
pointee's `_vt` as a pointer (the second load then dereferenced it). The
class-crossing branch already resolved the mono (`Box` → `Box_Node`); the
method-access branch did not.

**Fix:** in the method-access branch, resolve the monomorphized target name
(`target_type.type_args?.length ? mono_type_name(target_type) : target_type.name`)
before looking up the field declaration — mirroring the class-crossing branch.
A struct-typed `__value` then takes the inline-address path
(`add x0, x0, #off`) instead of a scalar load. Covered by
`test/box.test.ts` (`box_call_result_{c,aarch64}`), both backends.

## 13. aarch64: string interpolation in a class `#destroy` body (verified fixed)

**Reported on `main` (recorded 2026-10-06, B5/B6 tranche).** FOLLOWUP.md
claimed that `Console.write_line("destroy \{self.name}")` inside a class
`#destroy` body emitted the raw literal `destroy {self.name}` on aarch64
(the interpolation machinery never running in the destroy body build), while
C lowered it correctly.

**Verified fixed 2026-10-07 — not reproducible; no code change required.** The
symptom does not reproduce on current `main` or at the commit that recorded it
(`7ae8aaae`), on either backend. Exercised the stated shape plus the
surrounding variants: `class` vs `mv struct`, explicit `ref self` vs the
implicit destroy self, `mv string` / `var string` / defaulted / custom-`#init`
fields, generic monos (explicit and inferred call-site type args), nested and
class-field receivers, split-TU vs single-TU, and raw vs wrapped parses. Every
one lowers through the shared `_string_interpolate_N` helper and prints the
interpolated value (`destroy bob`); no generated `.s`/`.h` contains a raw
`{self.name}` literal. The destroy body rides the same checked-NIR body build
as every other function (`build_destroy_function` → `build_body_with_cursor`),
so the interpolation call lowers identically to a plain method. The entry was
removed from FOLLOWUP.md.

## 14. `List<OwningStruct>.at(i)` constraint verification (verified — intended bounds requirement)

**Reported on `main` (recorded 2026-10-06, B5/B6 tranche).** FOLLOWUP.md
claimed `List<OwningStruct>.at(i)` fails constraint verification
(`Parameter constraint cannot be verified: i / i >= 0 && i < self.length`)
while `List<int>.at(i)` works, attributing it to mv element types.

**Verified 2026-10-07 — not mv-specific; the error is the intended bounds
requirement.** `List.at`'s `i >= 0 && i < self.length` constraint is checked at
the call site for EVERY element type (it is not a runtime-checked accessor —
the backends emit an unchecked strided load). An index that is not provably in
range errors identically for `List<int>`, `List<Box<T>>`, `List<OwningStruct>`,
and nested-mv elements: `xs.at(0)`/`xs.at(i)` at root, in `main`, in a
helper, and in a user accessor all fail the same way. The accessor shapes
already exist (`at_or`, `at_or_panic`) and the guard/loop shapes discharge the
constraint for mv elements exactly as for primitives:

- `for x of list` (the desugar emits `list.at(__idx)` bounded by `list.length`),
- `for i of 0..list.length { list.at(i) }`,
- `while i < list.length { list.at(i) }`,
- `if i >= 0 && i < list.length { list.at(i) }` and the return-guard variants,

all compile and run on both backends with mv element types. No compiler
change was required. Regression coverage:
`test/constraints.test.ts` (`mv element type at verifies under a
return-guard`). The entry was removed from FOLLOWUP.md.

## 15. Nullable bases were not null-tracked (member access through a nullable field/box)

**Seen on `main` (recorded 2026-10-06, B5/B6 tranche).** A member access
through a nullable base compiled with no diagnostic: `o.inner.value` (where
`o.inner` is `Inner?`) and `box.next.value` (where `next` is `Box<Node>?`)
both read straight through a possibly-null pointer. The may-be-null check
(`Variable 'x' may be null`) only ran for plain variables (check_value_node's
`is_null`), never for a dotted base.

**Fix:** flow-sensitive nullable-base tracking, mirroring the per-variable
`is_null` semantics so it does not reject non-null values.

- `CheckStatus.null_paths` — dotted paths that MAY BE NULL; deep-copied per
  branch.
- `check_access_node` rejects a member access whose base is a nullable
  non-scalar dotted path in `null_paths` (`Variable 'o.inner' may be null`).
  Nullable scalars are excluded — reading one (even `.to_string()`) is not a
  pointer dereference.
- `get_null_check_var` now recognizes dotted bases (`o.inner != null`) and
  returns the canonical path; the `if != null`, `== null` guard-clause,
  `while != null`, and `&&` short-circuit forms narrow the set, and
  `check_if_else_node` reconciles it (conservative union) across fall-through
  branches.
- Paths are populated by `o.inner = null` / a null constructor argument
  (`Outer(null)`) and cleared by a non-null assignment/construction, so
  `var o = Outer(Inner(5)); o.inner.value` and
  `var w = Wrapper(Config("a")); w.c.name` stay legal. Covered by
  `test/nullable.test.ts` ("nullable base member access (null tracking)"), both
  backends.

## 16. aarch64: the nursery join clobbers whole-function-promoted registers

**Seen on `main` (recorded 2026-10-06, Phase R tranche 3; aarch64 only — C was
correct).** The 64-fiber `tcp_scale` program (`test/tcp.test.ts`, was
`test.skip`) hung forever in the main thread's `Channel.receive`
(`__nomen_fiber_waitq_park` → `pthread_cond_wait`): the async block joined, all
64 client fibers ran to completion and sent their `done.send(1)`, yet main
waited for one more message. The channel queue was empty, no fibers were live,
and the netpoller had no registered fd.

Root cause: whole-function register promotion (`plan_function_promotions`,
X_POOL `x23-x28`) promoted the loop bound `n` (= 64) into **x23**, and the
nursery join (`emit_nursery_join_a64`) uses x20/x22/x23 as scratch across its
`bl`s. The join's counter overwrote `n` with the nursery's FUTURE COUNT (65 =
server_loop + 64 clients), so the receive loop `while i < n` ran 65 times —
waiting for a 65th message that never arrives. The join's old contract
("nothing live across a join") predated whole-function promotion.

**Fix:** `emit_nursery_join_a64` now saves x20/x22/x23 around the join
(`stp x20, x22` + `str x23` on entry, restored after the futures-list free), so
a promoted local survives. The 64-fiber test is un-skipped and green on both
backends (`test/out/{aarch64,c}/tcp_scale/output.txt`).

## 17. Lint/type findings hidden behind `vp check`'s formatting gate

**Seen on `main` (recorded 2026-10-04, swept 2026-10-07).** `vp check` aborts
at the FORMATTING stage whenever any file has drifted, so the lint/type stage
behind it never ran and findings accumulated unnoticed. The sweep (all files
reformatted, then the stage's findings fixed) surfaced 4 type errors and ~25
lint warnings. The ones that were more than hygiene:

- **`ElemDesc`'s `load`/`store` unions lagged tranche 2** (`src/build_aarch64/
neon_plan.ts`): the element-descriptor table includes the byte lane
  (`load_u8`/`store_u8`, `.16b`), but the interface's string-literal unions
  were never widened — both TS2322/TS2820. The emitters drive off
  `arr`/`group_elems`/`float` (all correct for the `16b` entry), so this was
  a stale type, not a codegen bug; the unions now name `load_u8`/`store_u8`.
- **A null-named leaf index in a vectorizable loop lane** took the
  `.get(null)` path in `neon_plan.ts`'s method-call walk (TS2345): it
  happened to reject (map miss → `return null`), but only by accident of the
  type error being ignored at runtime. Now explicitly `return null` on a null
  leaf name before the induction comparison — same behavior, stated intent.
- **Dead `body_has_call` wrapper** in `src/build_aarch64/utils/
scan_inline_candidates.ts` (a thin alias of `body_calls`, unreferenced) —
  removed.
- **`new Array(files.length)`** in `cli/src/test.ts`'s test-runner pool
  (results collected by index) → `Array.from<TestFileResult>({ length })`,
  removing the length-vs-single-element ambiguity.
- Test hygiene: unused imports/vars across ~12 test files (including two dead
  `SYSTEM_SRC`/`SYSTEM_SRC_A64` consts in `test/system_lib.ts` — duplicates of
  `system_paths()`, which already handles the `.m`/`.c` platform split), a
  dead `check` helper and type alias, and the ANSI-strip regex in
  `test/test_reporter.test.ts` built via `String.fromCharCode(27)` instead of
  a literal control-character escape (`no-control-regex`).

`vp check` now passes with zero findings (format + lint + type). No runtime
behavior change — the full suite is green on both backends.
