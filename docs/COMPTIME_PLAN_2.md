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
2. **`#for` + `META.info(T).fields` + `field.get/set`** (R3, R4, R5, R8),
   validated by re-deriving `Stringable`/`Equatable`/`Hashable` (R9).
3. **Attributes** (D1) — sigil chosen then, surfaced via
   `META.info(T).fields[i].attrs`.
4. **Generic `T: type` parameters composing with reflection** (R3, R4).
5. **Unify `#arch`/`#platform` into `#if META`** (D2), once the raw-block
   shape and `aarch64_use_c` semantics are settled.
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
