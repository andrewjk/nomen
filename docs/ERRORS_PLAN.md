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
bare-return lifting, the `Result.error` → `Result.fail` rename, and `error`
joining the reserved words. Stage 2: the `!!` result-coalesce operator on both
backends. Stage 3: postfix `!` propagation. Composed chains (`T ! E1 ! E2`,
tag-by-origin), flat match arms, and nullable chaining remain designed but
staged (below).

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
Eager, like `??`. Consuming the `Result` discharges the checked rule by
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
enum in v1 — error-set widening is composition machinery, staged below.

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

## Composition: `T ! E1 ! E2` (designed, staged)

Chained error sets compose **by origin, not by case union**. `T ! E1 ! E2`
desugars to `Result<T, Composed>` where the E slot is an anonymous enum whose
cases carry the whole named enums — `[.e1(LoadError), .e2(ParseError)]`,
canonical generic tags never spelled in source, members sorted by name so
`! LoadError ! ParseError` ≡ `! ParseError ! LoadError` (riding the existing
order-insensitive anonymous-enum identity rule).

Matching uses qualified arms:

```
match load_and_parse(path) {
    case .ok(obj) { ... }
    case LoadError.timeout { ... }
    case ParseError.timeout { ... }      // collisions cannot exist:
    case ParseError.syntax(msg) { ... }  //   the cases live in different tags
    case LoadError(err) { ... }          // bind the whole error
}
```

- **Collisions stop being a concept.** The entire merge/rename problem is
  deleted: `.timeout` in both enums coexists because the cases live in
  different wrapper tags. Provenance is structural, not spelling.
- **The ambiguity rule** (the flat-surface force-specify): an unqualified
  `case .timeout` against a composed type is a compile error — "ambiguous
  between LoadError and ParseError — spell the origin: `case LoadError.
timeout`". When it resolves uniquely through one tag, plain shorthand
  works (single `T ! E` keeps today's `case .notfound` shorthand unchanged).
- **Propagation wraps whole values.** `return load(path)!` inside the
  composed function re-tags the entire `LoadError` — no per-case rebuild,
  no named→anonymous conversion machinery.
- Only `error` enums may join a chain; anonymous error sets
  (`! [.notfound]`) are a later maybe.

This needs: the type-grammar fold (checker-level, both members' case sets are
statically known), the qualified-arm lowering (the checker synthesizes
outer-tag + inner-case checks; no nested-patterns feature required), and the
ambiguity resolver. Deliberately NOT in v1.

## Staging

- **Stage 1 (v1)** — `error` keyword (parse/check/build as an always-checked
  enum); `T ! E` in the type parser → `Result<T, E>` + the function-level
  lifting flag; return lifting in the checker; the `Result.error` →
  `Result.fail` rename; `error` reserved.
- **Stage 2 (v1)** — `!!` on both backends (parse tier next to `??`,
  checker, C scratch lowering, aarch64 lowering).
- **Stage 3 (v1)** — postfix `!` propagation (return statements and
  declaration initializers/assignments; both backends).
- **Stage 4** — composition: `T ! E1 ! E2` per the section above, plus
  error-set widening (subset coercion scoped to the E slot).
- **Stage 5** — flat match arms (`case .notfound` through the `.fail`
  wrapper) as checker sugar.
- **Deferred** — nullable chaining (`?.` does not exist today; prerequisite
  for the `fetch(...)!.body !! ""` shape), anonymous error enums,
  assignment-position lifting.

## Checker rules

Each is one clear error:

- **E must be an error enum** — `T ! Direction` where `Direction` is a plain
  enum: "declare it `error enum` or spell Result<T, Direction>".
- **`!!` type shape** — left not a Result, or right not `T`: name both types.
- **Propagation context** — `expr!` in a function not declared `! E`, or
  whose error enum differs: name the enclosing signature's expectation.
- **Always-checked** — statement-position discard of an error enum or a
  `T ! E` result is the existing checked-enum error; `var _ =` and `!!` are
  the deliberate forms.

## Open questions

- **`void ! E`** — a fallible function returning nothing
  (`func close = () ! FileError`) needs a bare-`!` return form. Defer until
  a real API wants it.
- **Foreign funcs** cannot be fallible (scalars/strings only) — unchanged.
- **Assignment lifting** (`var r = 0` against a declared `int ! FileError`
  binding) — no in v1; revisit with a real consumer.
