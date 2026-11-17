# Comptime II: Review, Decisions, and Open Questions

Companion to [`COMPTIME_PLAN.md`](./COMPTIME_PLAN.md). That document is the
sketch; this one is the review of it plus the decisions we've made and the
problems we've deliberately deferred. Working document — nothing here is
implemented yet.

## Verdict on the original plan

Good plan, well-grounded. Every "new" mechanism it proposes already has a real,
half-built counterpart in the compiler:

| Proposed feature            | Existing precedent                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `#` directive namespace     | `#arch:` / `#platform:` / `#scope:` in `src/raw_directives.ts`                                          |
| `#if` constant folding      | `evaluate_const_condition` + `check_if_else_node.ts`                                                    |
| Per-instantiation constants | `T_SIZE` / `T_NEEDS_STRDUP` / `T_FAT` substitution (SPEC, Unsafe Code; GENERICS.md, Raw `#arch` blocks) |
| Reflection-driven derives   | hardcoded `Stringable` / `Equatable` / `Hashable` (SPEC, Auto-Derived Methods)                          |

So the plan is really "formalize and generalize what's already informal,"
which is the right framing. The staging (`#if` first, then `META.info` +
`#for`, then attributes, then declaration generation) is sound. The two things
it correctly calls out as load-bearing — field-name binding and diagnostics —
are the things that become archaeology if deferred.

## Decisions locked in

These came out of review and override the original plan where they conflict.

### D1. Attributes are punted — but keep the syntax choice open

The original plan treats `#[rename: "..."]` etc. as something to design up
front because retrofitting attribute syntax is painful. That's true, but we're
explicitly **not** designing the attribute system now. The plan is:

- **Punt on per-field metadata** (`META.info(T).fields[i].attrs`,
  serde-style defaults/skip/rename) until after `#for` works.
- **Do not commit to `#[...]`.** The `#` prefix collides conceptually with the
  raw-directive namespace (`#arch:`/`#platform:` are line-leading directives,
  and `#` is C-preprocessor syntax inside raw bodies). The two candidate forms
  we'd actually pick between later are:
  - `#rename("blah")` — consistent with the `#`-directive family, reads as a
    declaration directive.
  - `@rename("blah")` — a genuinely distinct sigil, no lexer ambiguity with
    raw directives.
- **Reserve the decision point.** Whichever we pick, attributes attach to
  field/method/struct declarations, which means touching
  `src/parse/parse_struct.ts` and `src/parse/parse_function.ts`. The only thing
  to do now is _not_ burn the `@` sigil and _not_ assume `#[...]`.

The `@field` / `field.get` discussion in the original plan is about _field
binding inside `#for`_, which is separate from attributes — see R5. Don't
conflate the two sigils.

### D2. `#if META` is intended to unify/replace `#arch:` and `#platform:`

The end state we're aiming at is a **single `#if META` mechanism** rather than
two parallel systems (`#arch:` tags on raw bodies vs. `#if META.arch` on Nomen
code). The original plan's bullet ("`#if` selecting between `#arch:` variants")
undersold this — the intent is to _absorb_ `#arch`/`#platform`.

Open questions this raises (reason out later, recorded here so we don't
rediscover them):

- **Raw bodies are opaque text.** `#arch:` is stripped by
  `parse_raw_directives` at parse time; the body is an uninterpreted string.
  A unified `#if` cannot live _inside_ a raw body (that's just `#ifdef`). The
  likely shape is that raw code becomes a statement/expression wrapped by
  `#if`: `#if META.arch == "aarch64" { <raw> }`. Need a raw block form that
  isn't a top-of-function directive tag.
- **`aarch64_use_c` breaks the one-dimensional model.** Today `arch ===
"aarch64"` also matches `aarch64_use_c`, which is _C_ source compiled via
  the companion file. A single `META.arch` predicate can't express that
  without a second axis. Options: expose `META.arch` (target) _and_
  `META.emit` / `META.backend` (`"c"` vs `"asm"` vs `"c_companion"`), and
  decide which predicate the old `aarch64_use_c` desugars to.
- **Backwards compatibility.** Keep `#arch:`/`#platform:` as sugar for the
  equivalent `#if`, or migrate core (`core/System/`) and drop them? Migration
  is cleaner long-term but touches every raw block; sugar means two code paths
  for a while. Undecided.
- **`META.arch` vocabulary** should reuse the strings already accepted by
  `parse_raw_directives` (`"c"`, `"aarch64"`, `"aarch64_use_c"`) so the two
  can't drift.

Everything else below is analysis to reason out later, not settled design.

## Review findings to flesh out

### R1. Make `#if`/`#for` their own node types, not `if`/`for`

The existing constant-fold path is a hack and shouldn't be the template:

- `is_unchecked_constant_condition` (`src/check/check_if_else_node.ts:270`)
  hardcodes only `T_NEEDS_STRDUP` and `T_FAT` — notably **not** `T_SIZE`.
- When it matches, it **skips checking both arms** (`:35`), because neither arm
  type-checks generically.
- Folding happens _after_ both branches have been checked and after
  flow-fact reconciliation (bounds, `is_set`, `is_null`, borrows) has run
  (`:92` onward).
- `if` is also an **expression**, not just a statement (an `if` without `else`
  in a declaration position is an error, `:246`).

A distinct `PragmaNode` / `ComptimeForNode` should instead:

1. evaluate the condition _before_ checking bodies,
2. check **only** the live arm,
3. never participate in flow analysis (bounds/`is_set`/`is_null`/borrows).

Keep the existing `if` hack for the `T_*` markers during migration; don't
route new features through `if`.

### R2. Expand at check time, not build time — generated code must be ordinary AST

The pipeline is `parse → check → NIR lowering (`src/nir/`) → backend`. The
monomorphizer already synthesizes concrete clones and injects them into
`root.statements` _during check_ (`monomorphize` in
`src/check/check_function_call_node.ts`), and NIR lowering happens after.

Therefore `#for` / `META.info` expansion must produce ordinary AST nodes
**before** the enclosing body is checked. If expansion is bolted onto the build
phase, generated code:

- skips ownership / strdup / auto-free / last-use analysis
  (`src/check/utils/last_use.ts`, the string-return analysis in
  `src/build_common/`),
- never lowers to NIR,
- and is invisible to both backends' expectation that they only see ordinary
  nodes.

State this as the phase contract: **generated code is indistinguishable from
hand-written code to the checker.** This is the single most important
structural constraint, and it's why R7 (diagnostics) and R3 (deferral) fall
out the way they do.

### R3. `#for` over an unbound `T` must _defer_, not error

Inside a generic body, `T` is unresolved (`CheckStatus.type_params`, and the
body is not checked until specialization — GENERICS.md, "Generic free-function
bodies are deferred"). So `#for field of META.info(T).fields` inside
`func JSON.decode<T>` cannot unroll at generic-body check time.

Mirror step 2 of `monomorphize` ("defer if any arg is still a type parameter"):
mark the loop **deferred** while `T` is unbound, and unroll it when the
specialization binds `T` to a concrete name, producing nodes that are then
checked normally (per R2). This is the crux of making
`func JSON.decode(T: type, s: string)` work, and it fits the existing design
rather than fighting it.

### R4. Reify "comptime value" as a first-class checker category

`META.info(T)`, `.fields[i]`, and the `#for` loop binding are values that exist
**only during check**. Nomen has no types-as-values today. Specify:

- these have a comptime-only type with **no runtime representation**, erased
  before NIR;
- the type of `T` in `func JSON.decode(T: type, ...)` is likewise comptime-only;
- the checker must never try to size, lay out, or emit one.

This is a new checker concept (Zig's `comptime`, Jai's `#`), and it should be
explicit rather than emergent.

### R5. Field access as methods, not a magic `@field`

The original plan calls the field-name binding problem "the linchpin" — agreed.
The proposal there is `@field(obj, "name")`. A better fit for Nomen's
value/field model (`AccessFieldNode`, `check_assignment_node`) is to make the
comptime field value carry `.get(obj)` / `.set(obj, v)`:

```
#for field of META.info(T).fields {
    obj.field.set(src.field.get(obj))
}
```

- `.get` yields the field's value at its concrete type.
- `.set` must yield an **lvalue**, so `check_assignment_node` needs to
  understand it (same machinery special-cased accessors already need).
- The loop binding exposes `.name`, `.type`, `.offset`, `.size` for the
  comptime-string / naming use cases.

This avoids adding a magic builtin with a two-argument lvalue form. (Note the
sigil question here is _separate_ from D1's attribute sigil — don't couple
them.)

### R6. Comptime string concatenation/formatting is its own feature

`"decode_" + T.name` cannot use runtime string concat, and `"\{...}"`
interpolation (`parse_string_interpolation`) is runtime. Generated symbol names
depend on this, so it needs its own restricted comptime evaluator for string
concatenation/interpolation. Promote it from a bullet under "what we'll want
cheaply" to a designed component. Open: whether it's part of the constant
grammar (same evaluator as `#if` conditions) or a separate mini-evaluator.

### R7. Diagnostics need a concrete field, added now

`CompileError` carries `start` / `line` / `column`. Add an origin/spawn field
to `BaseNode` (e.g. `spawn_of`, or a parallel map keyed by node) **now**, while
only the mono path clones nodes — every clone/splice site is currently
enumerable. Once `#for`-generated nodes are everywhere, retrofitting exactly
the archaeology the original plan warns about. Errors inside unrolled code
should report both the generated site and the spawning `#for`.

### R8. Hygiene for body unrolling

The original plan mentions hygiene only under declaration generation. But
unrolling a `#for` body N times **also** collides local names within one
function. The mono path already renames locals to the mono name
(`substitute_body_types` / local-label renaming in
`check_function_call_node.ts`); `#for` needs a per-iteration suffix on the same
mechanism. Decide before the first non-trivial `#for` body.

### R9. Derive the hardcoded derives as the milestone-2 acceptance test

Reimplementing `Stringable` / `Equatable` / `Hashable` (SPEC.md:1551) via
`#for field of META.info(T).fields` is the ideal forcing function for
milestone 2:

- needs only **body-scope** `#for` (no attributes, no declaration generation),
- validates `META.info` + `field.get/set` end to end,
- and dogfoods against a known-good implementation whose output can be diffed.

Elevate it from "good long-term target" to the acceptance criterion.

## Potential problems (summary)

1. **Attributes** — punted (D1). Don't commit to `#[...]`; `#rename(...)` or
   `@rename(...)` are the candidates.
2. **Two parallel config mechanisms** — resolved in intent by D2 (unify into
   `#if META`), but the raw-text/`aarch64_use_c` wrinkles are open.
3. **Comptime string formatting** — under-designed in the original; see R6.
4. **Hygiene** — original covers declarations only; body unrolling also needs
   it. R8.
5. **Diagnostics** — needs a concrete node field now, not a note. R7.
6. **Forward references** — original flags this but doesn't choose. Simplest
   v1 rule: `META.info(T)` may reference only already-checked types
   (declaration-before-use), with an explicit diagnostic. This sidesteps the
   Zig "unable to resolve comptime value" rabbit hole entirely for now.
7. **Ownership interaction** — reflection-generated reads/writes must feed the
   existing strdup/auto-free/last-use analyses. Another reason expansion
   happens pre-check (R2).

## Revised staging

1. **`#if` as a real node** (own parser + check, R1), constant-only conditions
   (`META.arch`, `META.platform`, plus a restricted comptime expression
   grammar), valid at declaration and body scope, evaluating before checking
   bodies and checking only the live arm. No `META.info`, no `#for`.
   **SHIPPED** — `PragmaIfNode` (`src/nodes/PragmaIfNode.ts`), parsed by
   `src/parse/parse_pragma_if.ts`, folded before checking by
   `fold_pragma_ifs` (`src/check/utils/pragma.ts`), which runs at the top of
   `check()` before `count_declared_type_names` so target-selected
   declarations register exactly once. Targets thread through
   `parse(source, lib, path, { arch, platform })` → `check()`; the CLI passes
   its config so check/build/run/test agree. Contract tests:
   `test/compile_time_if.test.ts`, `test/spec/compile_time_conditionals.test.ts`.
   Syntax: `#if <cond> { ... } else { ... }` and — for multi-arm target
   selection — `#switch { case <cond> { ... } ... } else { ... }`, spelled
   exactly like the runtime switch (subject-less `case` conditions, `else`
   OUTSIDE the braces). An interim `#elif` tag was replaced by `#switch`
   before release (design feedback: reuse the language's case/else keywords
   rather than a `#`-tag ladder).
   Notes from the implementation: arms parse with the PRAGMA on the stack as
   a statement collector (`PragmaIfNode.statements`, moved into the arm's
   block on close) so the parser's parent-type attach switches treat
   declarations inside arms like declarations in the enclosing scope
   (`parse_function.ts`/`parse_declaration.ts` gained `case "pragma_if"`);
   struct/trait-body arms are rejected at parse (no statement list to splice
   into — a stage-3+ problem with attributes). The backends were left
   STRICT: a `pragma_if` reaching a backend throws, since the fold runs
   unconditionally in `check()` — surviving nodes mean a fold gap (compiler
   bug), matching lower_function's "NIR lowering gap" contract.
2. **`#for` + `META.info(T).fields` + `field.get/set`** (R3, R4, R5, R8),
   validated by re-deriving `Stringable`/`Equatable`/`Hashable` (R9).
   **SHIPPED** — `PragmaForNode` (`src/nodes/PragmaForNode.ts`), parsed by
   `src/parse/parse_pragma_for.ts` (body scope; arms are ordinary nested
   blocks, so per-iteration scoping doubles as the R8 hygiene — no rename
   machinery needed), expanded by `src/check/utils/comptime.ts`
   (`expand_pragma_for` + the comptime substitution walk; R6 comptime
   string `+` folds literals; comptime-constant `if`s inside arms fold to
   their live arm, the `fold_substituted_constant_ifs` precedent). The
   checker dispatch (`check_pragma_for_node`) splices the per-field blocks
   directly after the pragma node so the enclosing live walk checks them in
   order; consumed placeholders are dropped post-check
   (`drop_pragma_for_placeholders` in check.ts). Deferral (R3): a `T` in
   `status.type_params` leaves the node; `specialize_function` rewrites the
   iterable's parameter references (`substitute_pragma_iterables`) and the
   re-check expands. Mono-struct method clones (never re-checked) expand in
   the hook next to `fold_substituted_constant_ifs`. R4 comptime bindings
   are erased during expansion — the checker never sizes one. R5: `.get`/
   `.set` desugar to ordinary field access/assignment (`.set` is a
   statement, so no lvalue plumbing). R7: `BaseNode.spawn_of` stamped on
   every cloned statement. Inference: bare `T` params bind from the
   argument's concrete type (`specialize_function`, incl. bare-struct
   constructor args in `infer_arg_type`); `META.info(T).name` resolves in
   any statement position (`rewrite_meta_name_chains`, per block, so
   re-checked clones resolve too). **R9 ACCEPTED**: `test/comptime_for.test.ts`
   re-derives all three derives with one generic each and diffs the runtime
   behavior against the hardcoded versions (JS backend, byte-identical
   `to_string`, matching eq and hash) plus a clean C build. Known gaps
   (loud, by design): `#for` inside a generic-struct method whose
   iterable's parameter never binds errors rather than silently dropping;
   reflection exposes no offsets/sizes yet; `#for` is body-scope only.
3. **Attributes** (D1) — sigil chosen then, surfaced via
   `META.info(T).fields[i].attrs`.
   **SHIPPED** — D1 RESOLVED: the sigil is `@`, one attribute per sigil,
   comma-separated on the line(s) above the declaration —
   `@rename("user_name"), @sql_type("VARCHAR")` / flag form `@deprecated` —
   NOT the bracketed `@[...]` list (no bracket matching; flags read
   clean). Args are comptime literals (string/int/bool). Parse:
   `parse_attributes` + a `pending_attributes` side channel on
   ParseStatus (the `@` case collects, the declaration parser consumes via
   `take_attributes`) at three attach sites — `parse_struct`,
   `parse_declaration` (struct/trait fields only; locals are rejected),
   `parse_function`. Surfacing: `BaseNode.attrs`, propagated through
   clone_node and the monomorphizer's field/struct reconstruction so
   reflected monos keep their metadata. Consumed via
   `META.info(T).attr(...)` / `.has_attr(...)` (struct level) and
   `field.attr(...)` / `field.has_attr(...)` (R5-style methods on the
   binding); `has_attr` is a comptime bool so the guard `if` folds and
   the untaken branch is never checked — a dead arm's `.attr` error
   cannot fire. `attr` on a missing attribute is a compile error pointing
   at `has_attr`, never a silent empty string. Acceptance:
   `test/attributes.test.ts` (incl. a runtime metadata consumer through
   the JS backend: table attr + field renames + plain-name fallbacks).
   Two pre-existing issues surfaced by this work, both now fixed: the
   JS-backend library-const default args (library enums are collected, so
   their case references lower to tag objects) and attribute names
   participating in the library type-link scan (the scan skips
   attribute-name tokens).
4. **Generic `T: type` parameters composing with reflection** (R3, R4).
   **SHIPPED** — the canonical spelling is `type T` (the ordinary
   `Type name` order — the annotation is the keyword `type`); the plan's
   `T: type` order parses to the same AST via a three-token intercept in
   `parse_function_parameter`. The parameter is stamped
   `ParameterNode.is_comptime_type` and its NAME is pushed into
   `func.type_params` at parse, which routes the function through the
   entire existing generic-function machinery unchanged (deferred body,
   backend skip, clone substitution plumbing). R4 erasure: the argument
   must be a bare type name (validated against structs + builtins —
   enums/traits/bitsets/generic spellings are rejected with targeted
   messages), it is bound under the parameter NAME in the substitution
   map, spliced out of the call, and filtered out of the clone's
   signature — no runtime slot exists, so no backend ever sees one.
   `META.info(T)` / `#for` / `T()` / comptime predicates all resolve
   through the stage-2 machinery keyed by that name; `META.is_struct(T)`
   folds at clone time so dead arms are dropped before the re-check.
   Forwarding (a generic parameter passed on as a `type` argument,
   `inner(T)` inside `outer<T>`) rides `CheckStatus.comptime_type_bindings`,
   set on the specialization re-check status and threaded through
   `clone_status`. One latent stage-2 gap surfaced and was fixed: the
   `.set(obj, value)` rewrite cloned the value expression verbatim — a
   binding use inside it (`field.set(c, field.get(d))`) never rewrote;
   both `.get`/`.set` arguments are now re-walked. Free-function only
   (methods rejected at parse); no constraint/declaration keyword/default
   value on a `type` parameter. Acceptance: `test/comptime_type.test.ts`
   (JS runtime incl. forwarding + memoization, C build) and
   `test/spec/comptime_type_params.test.ts`; SPEC.md gained a "Type
   Parameters (`type T`)" section and README's Generics section an example.
   Known gaps: none recorded — both stage-4 residuals (generic
   instantiations as `type` arguments, forwarding through struct bodies)
   are fixed; see GENERICS.md.
5. **Unify `#arch`/`#platform` into `#if META`** (D2), once the raw-block
   shape and `aarch64_use_c` semantics are settled.
   **SHIPPED** — decisions: (D5-1) the C-vs-assembly dialect is a property
   of the BLOCK, not the condition — a `#c` first line marks
   companion-compiled C source, and an UNMARKED block is the target's
   default dialect (inline assembly on aarch64, C on the C backend); the
   condition stays purely target-shaped (`META.arch` / `META.platform`).
   (D5-2) full migration — the in-band `#arch:` / `#platform:` tags are
   DELETED, and `parse_raw` rejects them with a migration-pointing error.
   (D5-3) `#scope: file` stays as the block's emission-scope header.
   Mechanically: `parse_raw_directives` shrank to `parse_raw_block` (peels
   `#c` / `#scope:` only — target matching is gone, because the `#if` fold
   at the top of check() already selected the target's arms); the 1,721
   core blocks were codemodded to `#if`-wrapped fences (adjacent c/aarch64
   pairs merged into `if/else`; `aarch64_use_c` became
   `#if META.arch == "aarch64"` + `#c`; the tricky `c, aarch64_use_c`
   comma list became a bare `#c` block — C dialect on every target). The
   tag-era "raw blocks for other architectures but no aarch64 block"
   build error is replaced by a CHECK-time guard: fold_pragma_ifs counts
   the raw statements removed from each function body
   (`FunctionNode.folded_away_raws`), and check_function_node rejects a
   raw-only implementation whose every arm folded away ("no implementation
   for this target") — callers would otherwise `bl` into nothing. The
   count covers pragmas NESTED in the body too, and the ownership scan
   reads it: a `#destroy` whose release lived in a folded arm keeps the
   struct owning on this target (a copy would leak, not double-free), so
   ownership classification is target-independent. The
   check-time scanners (mixed companion-C rejection, the string-mutation
   conservative rules, the `T_SIZE` numeric-vs-sizeof decision) now read
   the `#c` marker plus `CheckStatus.arch` instead of tag text.
   `CheckStatus.arch` threads the target (defaulting to "c"); per-target
   parses are now REQUIRED wherever one AST feeds both backends (the
   harnesses and ~100 test files were updated — the aarch64-only arms
   only exist in an aarch64-checked tree). Two latent bugs surfaced by the
   per-target parses were fixed: the C declaration path never substituted
   a top-level struct-const reference before applying named-field
   overrides (masked because an aarch64 build mutated the shared AST
   first), and `check_missing_return` didn't recognize pragma-wrapped raw
   bodies. Docs updated: AGENTS.md "Inline code blocks", SPEC
   ("Unsafe Code" / "Compile-Time Conditionals" wording), GENERICS.md
   ("Raw code blocks"), MEMORY/AARCH64/ASYNC/CLOSURE/GUI/CORE_RAW
   references. Known gaps recorded in FOLLOWUP.md.
   _Syntax follow-up (post-stage-5 review):_ the ``` fence was itself the
   last un-Nomen-shaped bit, so raw blocks are now `#raw { ... }` — a normal
   `#` directive with a brace-delimited body (braces inside strings/comments
   do not close it; one shared scanner in `src/raw_block.ts` serves the
   tokenizer and the formatter). The block's nature moved from header LINES
   onto the OPENER: `#raw` (target default dialect), `#raw("c")`
   (companion-C; the old `#c` line), `#raw(…, "file")` (the old `#scope:
file`). The node carries it (`RawNode.is_c` / `.scope`), deleting
   `parse_raw_block` and every leading-line scan. The fence and the header
   lines are rejected with a migration-pointing parse error; `core/` (1,721
   blocks) and the test fixtures were codemodded.
   The stage-5 codemod's `if/else` merge of adjacent raw arms was reverted:
   a raw arm now names its target explicitly on both arms (`#if META.arch
== "c" { #raw }` + `#if META.arch == "aarch64" { #raw }`). `else` on
   `META.arch` includes `"js"`, whose backend ignores raw nodes — the else
   arm was putting aarch64 assembly into JS-checked trees, and the
   "no implementation for this target" guard now exempts `arch === "js"`
   (a raw-only function has no JS arm by design). 155 core pairs and 19
   test-fixture pairs split; statement-level and platform `else` arms are
   untouched (a portable fallback is meaningful there).
6. (Someday) declaration/type generation.

## See also

- [`COMPTIME_PLAN.md`](./COMPTIME_PLAN.md) — the original sketch.
- [`GENERICS.md`](./GENERICS.md) — monomorphization, deferred generic bodies,
  raw `#arch` substitution.
- `src/check/check_if_else_node.ts` — the existing constant-fold hack.
- `src/check/check_function_call_node.ts` — `monomorphize`,
  `substitute_body_types`, `substitute_raw_in_node`.
- `src/raw_directives.ts` — current `#arch:` / `#platform:` / `#scope:`.
- SPEC.md, "Auto-Derived Methods" (1551) and "Unsafe Code" (2287).
