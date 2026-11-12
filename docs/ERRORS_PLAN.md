# Errors: `T ! E` results (design)

Fallible functions declare `out T ! E`; callers handle, pass on, or discard at
the point of encounter. No throwing, no handling "somewhere up the chain."
The semantics are exactly the checked-enum machinery Nomen already ships —
`checked enum Result<T, E>` in core — this plan adds the declaration form and
the ergonomic spine around it.

## Implementation status

DESIGN — recorded 2026-11-12, out of the errors discussion (the scratch notes
this file used to hold are folded into the sections below).

**Stages 1–3 implemented (2026-11-12).** Stage 1: the `error` keyword (always
checked, `!`-gated), the `T ! E` type form desugaring to `Result<T, E>` with
bare-return lifting (shorthand cases pre-wrapped into `.fail(...)` so the
standard per-argument expected-type machinery resolves them against the error
enum), the `Result.error` → `Result.fail` rename, and `error` joining the
reserved words. Stage 2: the `!!` result-coalesce operator on both native
backends plus JS. Stage 3: postfix `!` propagation — return statements and
declaration initializers, both native backends; the JS backend degrades via
the documented skip path (its expression model has no statement seam for an
early return). Both backends stamp the in-flight binding (checker-side
`in_flight_binding`) so the fail path's destroy walk skips the slot being
initialized and restores it for the ok path's scope-exit free; aarch64 tag
stores are 64-bit per the enum convention (a 32-bit store lets stack garbage
ride the tag word into every downstream comparison). `resolve_linked_types`
pulls the Result template for a `word ! word` token sandwich — the desugar
introduces the dependency after the scan. Composition (`T ! E1, E2`,
tag-by-origin), flat match arms, nullable chaining, and unit results landed
in the follow-up tranches recorded below. The teardown gap the new tests
surfaced — interpolated strings through chained enum-with-data returns, and
nested enum payloads — was fixed on both backends: the p! initializer marks
its binding heap-owned (aarch64 `last_result_is_heap`), the fail-path
reclaim skips hoisted temps whose initializer is the in-flight p!, and the
enum-payload walks recurse into enum-typed payloads (`free_payloads`
families and the aarch64 `emit_enum_payload_frees_at` walk).

## The problem

Today's failables: `checked enum Result<T, E>` (the core generic), `panic`
for broken invariants, and the `*_or_panic` / `*_or` library conventions for
contract-free reads. `Result` has the right enforcement — a statement-position
call whose value is discarded is a compile error — but the wrong ergonomics:
the success path is wrapped by hand (`return .ok(body)`), "pass it on" is a
hand-written match, and a defaulted discard is a two-line dance. The language
is young enough to give fallibility a first-class spelling while keeping
`Result` as the only semantics.

## The design

### `error` enums — the third specialized declaration

```
error FetchError {
    case notfound
    case network(string reason)
}
```

`error` joins `enum` and `bitset` as a specialized enum declaration. An error
enum IS an enum: cases, payloads, `match`, `.case` shorthand, and the
mv-payload rules all inherited unchanged. The keyword adds exactly two
semantics:

1. **Always checked.** The `checked` discard rules apply with no opt-out — a
   statement-position call returning an error enum is rejected; `var _ =` is
   the deliberate discard.
2. **`!`-eligible.** Only error enums may appear after `!` (below). A plain
   enum there is a compile error with a teaching message: declare it `error`
   or spell `Result<T, Direction>` explicitly.

`error` joins the reserved words. The rename that falls out: core's
`Result.error` case becomes `Result.fail` (47 sites across 8 core files,
plus the SPEC and its mirrored `test/spec/` blocks), and the `error`-named
error-code fields in `File`/`Http`/`Tcp` become `last_error` (the raw C
bodies' `self->error` follows — `errno` would collide with the C macro).
`fail` itself is free: the only existing `fail` is `Test.fail`, and method
names are exempt from reserved words.

Why a keyword and not a marker trait: enums cannot conform to traits today
(conformance and auto-derivation are struct-only), so `enum FetchError :
Error` prerequisites "enums gain trait conformance." `bitset` is the
precedent that a specialized declaration is the cheaper, more Nomen road —
usage semantics declared where the type is declared, enforced at every use.

### `T ! E` — sugar for `Result<T, E>`, plus lifting

```
func fetch = (string url, out string ! FetchError) { ... }
```

`T ! E` parses as the type `Result<T, E>`. The `!` form is pure sugar over
the core generic, so matching, monomorphization
(`Result_string_FetchError`), checked-ness, and both backends' enum lowering
apply unchanged. Because the desugar happens in the type parser, `T ! E`
works wherever types parse (fields, locals, parameters); the lifting below
is the only return-position-only piece.

A function declared with `!` **lifts** bare returns:

- `return expr` where `expr : T` → `Result.ok(expr)`
- `return expr` where `expr : E` → `Result.fail(expr)` — so `return
.notfound` works; the shorthand resolves against the error enum
- `return expr` where `expr` is already a `Result` (explicit `.ok(...)` /
  `.fail(...)`) passes through unchanged

Resolution order: as-is, then `T`, then `E`. `T` and `E` are disjoint by
construction (declaring `int ! IntError` is your own adventure; `T` wins).

Explicit `out Result<string, FetchError>` keeps today's explicit behavior —
`!` means "this function deals in results" and carries the lifting; spelling
`Result` by hand means writing the cases by hand. Arrow bodies lift like any
return (the arrow body IS a return).

### `!!` — the result coalesce (mirror of `??`)

```
const body = fetch("https://example.com") !! ""
```

`a !! b`: `a` must be `Result<T, E>`, `b` must be `T`, the result is `T`.
Lazy on both arms, like `??` (a fallback that allocates pays only when the
fail case fires). Consuming the `Result` discharges the checked rule by
construction. `!!` joins `COMPOUND_SYMBOLS`, which retires literal
double-negation (`!!x` becomes a parse error) — an acceptable, recorded
trade; `!` remains unary logical-not everywhere else.

### Postfix `!` — propagate

```
func load_and_parse = (string path, out string ! ParseError) {
    var body = load(path)!    // fail → .fail(err) returns from HERE
    return parse(body)!
}
```

`expr!` evaluates `expr` (which must be `Result<T, E>`); on the fail case
the payload returns from the enclosing function through its normal
early-return machinery (the same destroy-walking epilogue a `return` uses);
on the ok case the value is `T` and flows into the enclosing expression.
The enclosing function must itself be `!`-declared with the **same** error
enum — or, in a composed set, with a set containing the operand's error enum
(it widens through its origin tag; see Composition below).

### Matching

Nested, via the existing machinery — zero new match rules:

```
match fetch(url) {
    case .ok(body) { ... }
    case .fail(err) {
        match err {
            case .notfound { ... }
            case .network(reason) { ... }
        }
    }
}
```

The flat surface — `case .notfound` arms resolving through the `.fail`
wrapper — is checker sugar, staged below.

## Composition: `T ! E1, E2`

Error sets spell as a comma-separated list — the trait-list shape, not
stacked `!`s:

```
func load_and_parse = (string path, out string ! LoadError, ParseError) {
    var body = load(path)!
    return parse(body)!
}
```

The set composes **by origin, not by case union**. `T ! E1, E2` desugars to
`Result<T, Composed>` where the E slot is ONE anonymous enum whose cases
carry the whole member enums — `[.LoadError(LoadError),
.ParseError(ParseError)]`, generated tags never spelled in source, cases
canonically sorted by member name so `! A, B` ≡ `! B, A` (the existing
anonymous-enum identity rule gives structural equality for free).

- **Collisions stop being a concept.** `.timeout` in both enums coexists —
  the cases live in different origin tags. Provenance is structural.
- **Lifting resolves by origin.** `return <value>` lifts: `T` to `.ok`, a
  member enum value to that member's tag, an explicit Result through. A
  shorthand return (`.timeout`) resolves through the members: exactly one
  declaring it wraps through that origin; several is the force-specify
  error — qualify the origin (`LoadError.timeout`).
- **Propagation wraps whole values.** `return load(path)!` inside the
  composed function re-tags the entire `LoadError` — one origin-tag
  construction, no per-case rebuild. Error-set widening is scoped to the
  E slot: a callee's error enum must be one of the enclosing set's members
  (or the whole set, for pass-through).
- **Matching is flat** (stage 5): `case LoadError.timeout` addresses one
  case of one member, `case LoadError(err)` binds the whole member enum,
  and an unqualified `case .timeout` resolves across the members (ambiguous
  = force-specify). The checker lowers these into generated nested matches
  the builders already understand — branches are moved, never cloned.

Implemented (stage 4 core, 2026-11-12): the comma grammar (greedy member
list in the `!` clause — inner commas belong to the set), the composed
anonymous enum (materialized before the signature so the Result mono is
built over the enum mono, `Result_int__AnonEnum_…`), member-directed
lifting, the ambiguity rule, and propagation widening on both backends
(the fail path writes the outer Result tag + the origin-tagged member
value into the sret buffer; payload copies are aggregate-sized, not
word-sized). Enum-typed payloads follow the owning-payload contract: a bare
local donor MOVES into the case (the build suppresses its scope-exit
reclaim), a fresh construction transfers, a bare field read is rejected
(construct fresh or `mv` the field out), and borrowed arguments error —
`enforce_case_payload_ownership` classifies `is_owning` enums like owning
structs. Anonymous error sets (`! [.notfound]`) joined later (stage 5b).

## Staging

- **Stage 1 (v1)** — `error` keyword (parse/check/build as an always-checked
  enum); `T ! E` in the type parser → `Result<T, E>` + the function-level
  lifting flag; return lifting in the checker; the `Result.error` →
  `Result.fail` rename; `error` reserved.
- **Stage 2 (v1)** — `!!` on both backends (parse tier next to `??`,
  checker, C scratch lowering, aarch64 lowering).
- **Stage 3 (v1)** — postfix `!` propagation (return statements and
  declaration initializers/assignments; both backends).
- **Stage 4 (v1, comma syntax)** — composition (`T ! E1, E2` per the
  section above) with member-directed lifting, the ambiguity rule, and
  error-set widening — done.
- **Stage 5 (done)** — flat match arms: `.notfound` through the `.fail`
  wrapper, `case LoadError.timeout`, and `case E(err)` whole-member binds,
  lowered by the checker into nested matches
  (`check/utils/flat_error_arms.ts`); mixing with an explicit `.fail` arm
  is rejected, and per-member exhaustiveness falls out of the generated
  matches. One parser addition: `Enum(bindings)` patterns (uppercase head +
  parens).
- **Stage 5b (done)** — anonymous error sets (`T ! [.case, ...]`): the E
  slot is an inline anonymous enum that IS the error enum (stamped
  `is_error`; bare returns, flat arms, and the anonymous call shorthand all
  resolve through it). The success side may be an anonymous enum too
  (`out [.ok, .redirect] ! E`); success-side enums match through
  `.ok(value)` — `.ok` stays the Result's case. Anonymous sets cannot join
  a composed set. The top-level `parse_type` is a wrapper over the base
  parser so the suffix applies after early-returning shapes (tuples /
  anonymous enums), and the link scan pulls Result for `!` before `[`.
- **Stage 5c (done)** — unit results (`out ! E`): a function that returns
  nothing but may fail, spelled without a success type and without a new
  keyword. Desugars to the core `UnitResult<E>` (the `Result` shape with a
  payload-less `ok`), so the `!` gate, lifting, flat arms, composition, and
  checked-discard all reuse the Result machinery. Fall-through and a bare
  `return` are success (the checker appends a trailing bare return so the
  return builders emit the ok case); a plain returned value is evaluated
  and discarded (`return load(p)!`); `!!` is rejected (nothing to
  coalesce). Value-less propagation (`close()!`) is allowed in unit-result
  functions only. One gap fixed en route: the statement-start postfix loop
  was missing the `!` case, so a standalone `f()!` statement parsed as two
  statements.
- **Stage 5d (done)** — nullable chaining (`a?.b`, `a?.b?.c`, `a?.b.c`,
  `a?.m(args)`, `f()?.x`): a missed target yields null. Because nullable
  values are per-slot (in-band strings, companion `_has` flags), a chain's
  nullness rides the same carriers a nullable call result uses, so a chain
  lowers anywhere a nullable value is consumed. The coalesce/test forms
  came first (`chain ?? fallback` — lazy, single evaluation; `chain == /
!= null` — the combined hop test); the value forms followed: declaration
  and assignment initializers (the chain writes the companion flag through
  the `current_nullable_call_flag` protocol on C, straight slot stores on
  aarch64), returns (the hidden `_ret_has` out-param), and arguments
  (the checker hoists the chain into a `_param_N` temp whose flag rides
  the companion parameter). Method-call hops check the guarded call as an
  ordinary access and keep the checked node on the chain; bases that would
  be evaluated once per hop test (a call base, a call inside the base
  path, or a method hop with further steps) hoist into `_chain_N` temps.
  The checker rejects a nullable chain as a `??` FALLBACK (the fallback
  slot has no carrier for the chain's nullness) — spell the coalesce on
  the chain itself (`x ?? (b?.c ?? fb)`). A chain whose final member is
  itself a nullable field read with a plain `.` is sound: the field's own
  flag becomes one more hop in `flatten_null_chain`
  (`src/build_common/null_chain.ts`).
- **Deferred** — assignment-position lifting (see below). (The general
  nullable-expression carrier is no longer deferred for chains: a chain
  lowers as a nullable value in the per-slot carriers — Stage 5d above.
  What remains general-expression-position is a chain as a `??` FALLBACK,
  rejected with guidance.)

## Checker rules

Each is one clear error:

- **E must be an error enum** — `T ! Direction` where `Direction` is a plain
  enum: "declare it `error enum` or spell Result<T, Direction>".
- **Every set member** — the same gate applies to each name in
  `T ! E1, E2`; a non-error member names itself.
- **Ambiguous shorthand** — `.timeout` declared by several set members
  (return position and flat match arms alike): spell the origin
  (`LoadError.timeout`).
- **Flat-arm mixing** — a `.fail(err)` arm and flat error arms in one match
  compete for the outer tag: rejected; likewise `case E(err)` and
  `case E.case` arms for the same origin.
- **`!!` type shape** — left not a Result, or right not `T`: name both types.
- **Propagation context** — `expr!` in a function not declared `! E`, or
  whose error enum is neither the enclosing set nor one of its members:
  name the enclosing signature's expectation.
- **Always-checked** — statement-position discard of an error enum or a
  `T ! E` result is the existing checked-enum error; `var _ =` and `!!` are
  the deliberate forms.

## Open questions

- **Foreign funcs** cannot be fallible (scalars/strings only) — unchanged.
- **Assignment lifting** (`var r = 0` against a declared `int ! FileError`
  binding) — no in v1; revisit with a real consumer.
