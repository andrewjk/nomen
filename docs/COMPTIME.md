# Compile-Time Features (Comptime)

Nomen's compile-time surface is the `#`-directive family plus the `META`
namespace. It has two jobs: **selecting** code per compilation target
(`#if` / `#switch`) and **generating** code from the program's own shape
(`#for` over reflected fields, enum cases, ranges, string tables and
attribute-collected type sets).

Everything here is resolved during check, before either backend sees the
tree. Generated code is ordinary AST — it goes through the same type
checker, ownership analysis, last-use analysis and code generation as
hand-written code.

```
#if META.arch == "c" { ... }                       // target selection
#for field of META.info(T).fields { ... }          // reflection loop
#for i of 0..16 { ... }                            // comptime range
#for w of ["get", "post"] { ... }                  // string table
#for c of META.info(E).cases { ... }               // enum cases
#for t of META.types_with("entity") { ... }        // attribute type set
#error "message"                                   // user compile error
```

## Phase Contract

`parse → (fold targets) → check (expand generation) → NIR → backends`

- **Target selection folds first.** `fold_pragma_ifs` runs at the top of
  `check()` and splices the selected arm's statements/declarations into the
  parent list before anything else runs — before gather, name counting and
  checking. A dead arm is never checked, so it may reference names that do
  not exist for the target. Because the fold is target-dependent, **any AST
  that feeds both native backends must be parsed once per target**; the
  test harness and CLI do this, and the check carries the same
  `arch`/`platform` consts.
- **Generation expands during check.** `#for` nodes expand when the
  statement walk reaches them (`check_pragma_for_node`), producing ordinary
  statements; type-body `#for` expands at the type's own check
  (`expand_struct_member_pragmas` / `expand_enum_member_pragmas`).
- **Generated code is indistinguishable from hand-written code** to the
  checker: it is type-checked, ownership-classified and code-generated
  normally. Backends are strict — a pragma node reaching one is a compiler
  bug, except for deliberately deferred loops in never-built generic
  bodies.

## Target Selection

`#if <cond> { ... } else { ... }` and the multi-arm
`#switch { case <cond> { ... } ... } else { ... }` (subject-less `case`,
`else` outside the braces — the runtime switch grammar).

The condition grammar is structural (no name resolution): `META.arch`
(`"c"` / `"aarch64"` / `"js"`), `META.platform` (host- or flag-derived),
string and int literals, `+ - * / %` (int; division by zero is an error),
comparisons `== != < <= > >=` (same-kind operands), `&& || !`, parentheses.

Arm scope:

- **Statement scope** — statements inside a function/block body.
- **Declaration scope** — whole functions/structs/enums/traits at file
  scope (and inside `#switch` arms).
- **Type-body scope** — struct/trait members and enum cases, via the
  type's `member_pragmas` list (the selected arm's members distribute into
  the body at the fold). A constructor covers selected fields normally.
  An `#if`-selected enum case needs a literal name (a `#{...}` template
  needs a `#for` binding).

A pragma with no matching arm and no `else` disappears entirely.

**Raw blocks** integrate here: `#raw { ... }` (target default dialect),
`#raw("c") { ... }` (companion-compiled C, reserved for UI/AppKit/UIKit
bridging), `#raw(..., "file")` (hoisted to file scope). Target selection is
the surrounding `#if META.arch`; a target-exclusive raw arm names its
target explicitly rather than using `else` (because `else` includes `"js"`,
whose backend ignores raw nodes). A raw-only function whose every arm
folds away is rejected ("no implementation for this target") on the native
backends; the JS backend is exempt. The fold counts dropped raw
statements per function (`folded_away_raws`) so ownership classification
stays target-independent.

## `#error`

`#error "message"` is a checked statement: the statement walk reports the
message as a compile error when it reaches the node. Because target
selection runs first, an `#error` inside a dead arm never fires — the
standard shape is a target gate (`#if META.arch == "js" { #error ... }`).
The message is a single string literal today.

## Reflection Loop (`#for`)

`#for <binding> of <iterable> { ... }` unrolls the arm once per item.

### Iterables

| Iterable                  | Items                                                                                      | Binding members                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `META.info(T).fields`     | a non-generic struct's typed fields                                                        | `.name`, `.type.name`, `.type.arg_count`, `.type.args[i]`, `.is_struct`, `.is_scalar`, `.attr("x")`, `.has_attr("x")`, `.get(obj)`, `.set(obj, v)` |
| `META.info(E).cases`      | a non-generic enum's cases                                                                 | `.name`                                                                                                                                            |
| `0..16`                   | comptime ints (exclusive end, matching range-for)                                          | `#i` (int value), `#{i}` (name text)                                                                                                               |
| `["get", "post"]`         | comptime string entries                                                                    | `#w` (string value), `#{w}`                                                                                                                        |
| `META.types_with("attr")` | non-generic, non-builtin structs carrying `@attr`, in registration order (deduped by name) | `.name`, `#t` (the type itself), `META.info(#t)`                                                                                                   |

`META.info(T)` also exposes `T`'s own `.name`, `.field_count`,
`.attr("x")`, `.has_attr("x")`. Type predicates `META.name(T)`,
`META.is_struct(T)`, `META.is_container(T)`, `META.is_scalar(T)` fold in
any statement position.

Reflection is order-independent within a module: gather registers every
file-scope declaration before check runs, so `META.info(T)` and
`META.types_with("x")` may name a type declared later in the file.

### Binding spellings

- **A member is bare** — `field.name`, `field.get(obj)`, `case.name`,
  `t.name`. The member shape identifies the binding; expansion folds it
  (`.name` → string literal, `.get`/`.set` → ordinary field
  access/assignment). An unknown member is a loud error — there is no
  suffix gluing in expressions (`field.name_id` names a member called
  `name_id`).
- **The binding's whole value needs `#`** — `#i`, `#word`, `#t` (as in
  `META.info(#t)`). Expansion runs before scoping, so a bare identifier
  cannot be distinguished from a local; the binding name is reserved
  inside its arm and the marker folds the use to its value.
- **A splice inside an identifier needs `#{...}`** — `#{field.name}`,
  `get_#{field.name}`, `#{field.name}_id`, `keys_#{t.name}`. Names are
  plain strings on declarations, so the parser carries a template
  (literal text with `#{path}` markers) and expansion folds it. Braces are
  required; glued text on either side is literal template text.

### Phases and deferral

- **Concrete iterables expand immediately**, each iteration into a fresh
  scoped block (hygiene: iteration locals cannot collide). At file scope
  the iteration statements splice flat (whole declarations become root
  statements).
- **Generic bodies defer.** If the iterable's head is inside
  `status.type_params`, the loop stays in the tree; the specialization
  rewrites the iterable's type-parameter references
  (`substitute_pragma_iterables`) and re-checks the clone, expanding then.
  Mono-struct method clones are never re-checked — their loops expand in
  the clone hook (`expand_pragma_fors_in_list`).
- **Struct/trait/enum bodies expand at the type's own check** (member
  pragmas), before members are processed, so the auto `#init` can be
  re-synthesized over the final field list.
- **File-scope loops expand before the statement walk.** They generate
  whole declarations (structs, traits, functions) with spliced names,
  registered in expansion order — so a later loop's reflection sees an
  earlier loop's generated types, and code before the loop can already
  use them. A file-scope arm may also `extend struct #{t.name} { ... }`:
  generated extensions are merged by `apply_extensions` before checking,
  so their methods behave exactly like in-body methods (the target may be
  declared later in the file). A body-scope `#for` cannot generate an
  extension — the merge already ran — and reports that as an error.
- **Type-body loops cannot defer** (there is no specialization to
  re-check a type body): an unbound parameter there is a compile error.

### Reflection-derived methods

A trait default body that binds `#self` is a reflection default: the body
is deferred at the trait (the marker joins the function's type params) and
**bound per conformer** — cloned with `#self` → the conformer's name and
the loop iterables rewritten, then checked fresh. That is how
`Stringable`/`Equatable`/`Hashable` derive `to_string`/`eq`/`hash` from
`core/System/*.nm`'s `#for` bodies (attribute-configured, e.g.
`@hash_ignore`). Conformance without a hand-written method binds the
default; a hand-written method always wins. Monomorphized structs bind in
the monomorphize hook. The trait-level default emission is skipped for
bodies that are deferred this way.

Generated types (`#{...}`-spliced) bind `#self` to their own name before
their members are checked, so `META.info(#self)` works in generated
bodies exactly as in trait defaults.

## Type Parameters (`type T`)

`func f(type T, ...)` (or `T: type`) declares a comptime-only type
parameter: erased before codegen (no runtime slot), erased from the clone's
signature, bound by name in the substitution map. `META.info(T)` / `#for`
/ `T()` / `META.is_struct(T)` resolve through that name; deferral and
forwarding (`inner(T)` inside `outer<T>`) ride `comptime_type_bindings`.
Free functions only; the argument must be a bare type name validated
against structs and builtins.

## Attributes

`@Name("x")` / `@flag` above a struct, field, or function declaration
(comma-separated for several). Arguments are comptime literals
(string/int/bool). The compiler assigns them no meaning — generic code
consumes them: `META.info(T).attr("x")` / `.has_attr("x")`,
`field.attr("x")` / `field.has_attr("x")`. `has_attr` is a comptime bool,
so a guard `if` folds and the untaken arm (which may call `.attr` on a
missing attribute) is never checked. `.attr` returns the attribute's first
value; a missing attribute is a compile error pointing at the `has_attr`
guard. Attribute names are lookup keys, not symbols (the library type-link
scan skips them).

## Implementation

| Concern                                                    | File                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Raw-body scanning (braces/strings/comments)                | `src/raw_block.ts`                                                                                             |
| `#if` / `#switch` parse                                    | `src/parse/parse_pragma_if.ts`                                                                                 |
| `#for` parse, `#{...}` name templates                      | `src/parse/parse_pragma_for.ts`, `src/parse/utils/consume_comptime_name.ts`                                    |
| `#error` parse                                             | `src/parse/parse_pragma_error.ts`                                                                              |
| `#error` check (reports at the statement walk)             | `src/check/check_node.ts` (`pragma_error` case)                                                                |
| Enum-case declarations in arms                             | `src/parse/utils/parse_enum_case_decl.ts`                                                                      |
| Attribute parse/attach                                     | `src/parse/utils/parse_attributes.ts`                                                                          |
| Target fold (`fold_pragma_ifs`, member folds)              | `src/check/utils/pragma.ts`                                                                                    |
| Expansion, name/type splices, deferral, binding resolution | `src/check/utils/comptime.ts`                                                                                  |
| File-scope pre-expansion (`expand_file_scope_pragmas`)     | `src/check/utils/comptime.ts`, `src/check/check_block_node.ts`                                                 |
| Per-conformer trait defaults                               | `src/check/utils/trait_defaults.ts`                                                                            |
| Statement/type/body wiring                                 | `src/check/check_pragma_for_node.ts`, `check_struct_node`, `check_trait_node`, `check_enum_node`, `check_node` |

Placeholder `pragma_for` nodes are dropped after check
(`drop_pragma_for_placeholders`); deferred loops in never-built generic
bodies go with them.

## Design History

The feature set landed in stages (code comments reference these numbers).
This document supersedes the retired working notes `COMPTIME_PLAN.md` and
`COMPTIME_PLAN_2.md`; their remaining TODOs moved to
[`FOLLOWUP.md`](../FOLLOWUP.md) ("Comptime residuals").

1. `#if`/`#switch` as real nodes — fold before checking, only the live arm
   checked; declaration and body scope.
2. `#for` + `META.info(T).fields` + `field.get/set` — reflection loops,
   deferred through generics, comptime string `+` folding, derived methods
   re-expressed as `#for` (R9 acceptance).
3. Attributes (`@Name(...)` / `@flag`) surfaced through `META`/`field`.
4. `type T` comptime type parameters composing with reflection.
5. `#raw` unification into `#if META.arch` (the `#arch:`/`#platform:` tags
   were deleted).
6. Declaration/type generation: type-body `#if`/`#for` (struct, trait,
   enum), `#`-spliced names (prefix, braced suffix/middle, type splices),
   file-scope generation (including `extend` of an existing type), and the
   iterable surface above (ranges, tables, enum cases, attribute type
   sets), with reflection defaults bound per conformer (`#self`).

## Known Limits

Recorded in [`FOLLOWUP.md`](../FOLLOWUP.md) ("Comptime residuals" and
"Declaration/type generation (stage 6)"): no offsets/sizes in reflection,
no comptime string interpolation, `#if` conditions limited to
`META.arch`/`META.platform` (no type-level conditions), single-literal
attributes, no whole-enum declaration splices, no deep payload splices
for generated enum cases, no trait-conformer iteration, and a
deliberately restricted model: no user comptime evaluation and no
syntax/AST macros (see [`COMPTIME_COMPARISON.md`](./COMPTIME_COMPARISON.md)).

## See Also

- [`COMPTIME_COMPARISON.md`](./COMPTIME_COMPARISON.md) — how this compares
  to Zig comptime, Rust macros, Swift macros and C# source generators.
- [`GENERICS.md`](./GENERICS.md) — monomorphization and deferred generic
  bodies.
- [`MEMORY.md`](./MEMORY.md) — the ownership model generated code obeys.
- `SPEC.md`, "Compile-Time Conditionals", "Compile-Time Reflection",
  "Type-Body Loops", "Declaration Generation", "Compile-Time Iterables",
  "Comptime Binding Spellings".
