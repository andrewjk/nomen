# Errors: `T ! E` results

Fallible functions declare `out T ! E`; callers handle, pass on, or discard at
the point of encounter. No throwing, no handling "somewhere up the chain."
The semantics are exactly the checked-enum machinery Nomen already ships —
`checked enum Result<T, E>` in core — with the declaration form and the
ergonomic spine around it.

This is the design + implementation reference. The LANGUAGE CONTRACT — the
syntax, the checker rules as user-facing errors, and a worked example per
form — lives in [`SPEC.md`](../SPEC.md) ("Errors" and "Nullable chaining");
the mirrored `test/spec/errors.test.ts` blocks pin it. This document covers
what the forms mean, how they lower, and what was deliberately left out.

Formerly `docs/ERRORS_PLAN.md` (the staged plan; every stage shipped — see
the history note at the end). Code comments citing `ERRORS_PLAN` refer to
this document's sections, which keep the plan's names.

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
2. **`!`-eligible.** Only error enums may appear after `!`. A plain enum
   there is a compile error with a teaching message: declare it `error`
   or spell `Result<T, Direction>` explicitly.

`error` is a reserved word. The rename that fell out: core's `Result.error`
case became `Result.fail`, and the `error`-named error-code fields in
`File`/`Http`/`Tcp` became `last_error` (the raw C bodies' `self->error`
follows — `errno` would collide with the C macro).

Why a keyword and not a marker trait: enums cannot conform to traits today
(conformance and auto-derivation are struct-only), so `enum FetchError :
Error` prerequisites "enums gain trait conformance." `bitset` is the
precedent that a specialized declaration is the cheaper, more Nomen road —
usage semantics declared where the type is declared, enforced at every use.
(The marker-trait endgame in `FOLLOWUP.md` revisits the general mechanism;
the `error` keyword does not block on it.)

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

Explicit `out Result<string, FetchError>` keeps the explicit behavior — `!`
means "this function deals in results" and carries the lifting; spelling
`Result` by hand means writing the cases by hand. Arrow bodies lift like any
return (the arrow body IS a return).

**Assignment position does not lift** (deliberate — see Residuals): only
return statements and declaration initializers through `!`-propagation lift.

### `!!` — the result coalesce (mirror of `??`)

```
const body = fetch("https://example.com") !! ""
```

`a !! b`: `a` must be `Result<T, E>`, `b` must be `T`, the result is `T`.
Lazy on both arms, like `??` (a fallback that allocates pays only when the
fail case fires). Consuming the `Result` discharges the checked rule by
construction. `!!` joined `COMPOUND_SYMBOLS`, which retires literal
double-negation (`!!x` is a parse error) — an acceptable, recorded trade
(`src/tokenize.ts`); `!` remains unary logical-not everywhere else.

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

### Handling: `try / catch`

The error side is handled at the point of encounter with `try expr catch`.
The catch arms address the error enum directly; the success side is implicit
— the ok value flows through as the expression's value, so the successful
arm is never written:

```
func describe = (string url, out string) {
    return try load(url) catch {
        case .notfound -> "missing"
        case .offline -> "offline"
    }
}
```

In a composed set, arms may name the origin (`case LoadError.timeout`), bind
a whole member (`case LoadError(err)` — the inner match resolves its cases),
or stay unqualified when exactly one member declares the case. The checker
synthesizes the success arm (binding the ok payload and transferring it out
as the match's value — the payload's ownership leaves the scrutinee temp,
`MatchNode.payload_moved_out` + the `is_case_move` branch stamp) and lowers
the catch arms into generated nested matches the builders already understand
— branches are moved, never cloned
(`src/check/utils/flat_error_arms.ts`); per-member exhaustiveness falls out
of the generated matches. One parser addition: `Enum(bindings)` patterns
(uppercase head + parens). Unit results (`out ! E`) have no success value to
flow through, so `try` rejects them — propagate with `!`, discard with
`var _ =`, or match explicitly.

`match` stays the explicit both-sides spelling: its arms are the result's
own cases (`.ok(value)` / `.fail(err)`), and an error-side case there is a
checker error pointing at `try/catch`. An arm that yields its own case
binding (`case .ok(v) -> v`, `case .fail(err) { return err }`) transfers the
payload out — the scrutinee cleanup keeps it and the join does not dup it.

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
- **Anonymous sets** (`T ! [.case, ...]`): the E slot is an inline anonymous
  enum that IS the error enum (stamped `is_error`; bare returns, flat arms,
  and the anonymous call shorthand all resolve through it). The success side
  may be an anonymous enum too (`out [.ok, .redirect] ! E`); success-side
  enums match through `.ok(value)` — `.ok` stays the Result's case.
  Anonymous sets cannot join a composed set. The top-level `parse_type` is a
  wrapper over the base parser so the suffix applies after early-returning
  shapes (tuples / anonymous enums), and the link scan pulls `Result` for
  `!` before `[`.
- **Enum-typed payloads** follow the owning-payload contract: a bare local
  donor MOVES into the case (the build suppresses its scope-exit reclaim), a
  fresh construction transfers, a bare field read is rejected (construct
  fresh or `mv` the field out), and borrowed arguments error —
  `enforce_case_payload_ownership` classifies `is_owning` enums like owning
  structs.

### Unit results: `out ! E`

A function that returns nothing but may fail, spelled without a success type
and without a new keyword. Desugars to the core `UnitResult<E>` (the
`Result` shape with a payload-less `ok`), so the `!` gate, lifting, flat
arms, composition, and checked-discard all reuse the Result machinery.
Fall-through and a bare `return` are success (the checker appends a trailing
bare return so the return builders emit the ok case); a plain returned value
is evaluated and discarded (`return load(p)!`); `!!` is rejected (nothing to
coalesce). Value-less propagation (`close()!`) is allowed in unit-result
functions only.

## Nullable chaining (`?.`)

The errors spine owns nullable chaining: `a?.b`, `a?.b?.c`, `a?.b.c`,
`a?.m(args)`, `f()?.x` — a missed target yields null (Stage 5d of the plan;
the language contract is SPEC "Nullable chaining"). Because nullable values
are per-slot (in-band strings, companion `_has` flags), a chain's nullness
rides the same carriers a nullable call result uses, so a chain lowers
anywhere a nullable value is consumed:

- **Coalesce and tests**: `chain ?? fallback` (lazy, single evaluation;
  per-arm ownership — a producer arm transfers, an alias arm strdups) and
  `chain == / != null` (the combined hop test).
- **Value forms**: declaration and assignment initializers (the chain writes
  the companion flag through the `current_nullable_call_flag` protocol on C,
  straight slot stores on aarch64), returns (the hidden `_ret_has`
  out-param), and arguments (the checker hoists the chain into a `_param_N`
  temp whose flag rides the companion parameter).
- **Single evaluation**: bases that would be evaluated once per hop test (a
  call base, a call inside the base path, or a method hop with further
  steps) hoist into `_chain_N` temps; method-call hops check the guarded
  call as an ordinary access and keep the checked node on the chain
  (`node.call`).
- **A chain cannot be a `??` FALLBACK** (the fallback slot has no carrier
  for the chain's nullness) — spell the coalesce on the chain itself
  (`x ?? (b?.c ?? fb)`).
- **A plain field read on a nullable struct/scalar BASE coalesces like the
  chain**: `y.v ?? fb` is checker-rewritten to the chain shape (`y?.v`) so
  the base's `_has` flag joins the test; `??` on a non-nullable LEFT is
  rejected (the fallback could never run — and the generic lowering tests
  raw bytes as the condition).
- A chain whose final member is itself a nullable field read with a plain
  `.` is sound: the field's own flag becomes one more hop in
  `flatten_null_chain` (`src/build_common/null_chain.ts`).

## Implementation map

- **Parse** — `tokenize.ts` (`!!` in `COMPOUND_SYMBOLS`, `error` reserved),
  `parse_type.ts` (the `T ! E` sandwich, the composed-set comma grammar, the
  anonymous-set suffix), `parse_function.ts` (the `out ! E` unit form),
  `parse_enum.ts` (the `error` keyword), `parse_expression.ts` /
  `parse_statement.ts` (`!!`, postfix `!` — including the statement-start
  loop's `!` case), `parse_match.ts` (`Enum(bindings)` patterns),
  `parse.ts` (`resolve_linked_types` pulls the Result template for the
  `word ! word` desugar), `parse_visibility.ts` (`error` in the reserved
  set).
- **Check** — `check_function_node.ts` (the lifting flag + member-directed
  resolution; `is_error` gating), `check_operation_node.ts` (`!!` typing,
  the `??` nullable-left rule, the flagged-base field-read rewrite),
  `check_return_node.ts` (bare-return lifting, `p!` context/widening),
  `check_declaration_node.ts` (in-flight `p!` initializers),
  `check_enum_node.ts` (`error` = always-checked), `check_match_node.ts` /
  `utils/flat_error_arms.ts` (catch arms → generated nested matches, the
  retired-flat-arm guard),
  `check_null_access_node.ts` / `check_null_chain` machinery (Stage 5d).
- **Nodes** — `Type.ts` (`!` result types), `FunctionNode.ts` (lifting
  stamps, result error sets), `OperationNode.ts` (`coalesce_ok_field`,
  `propagate_fail_field`, `propagate_into`, `in_flight_binding`),
  `ReturnNode.ts`, `NullAccessNode.ts`, `EnumNode.ts` (`is_error`).
- **Build (C)** — `build_operation_node.ts` (`!!` statement-expression with
  per-arm ownership; the generic `??` paths), `build_return_node.ts` (p!
  early-return + fail-slot writes, string-return strdup boundary),
  `build_declaration_node.ts` (in-flight binding splice/restore),
  `build_null_chain_value.ts` (the chain-as-value statement-expression),
  `build_node.ts` (dispatch).
- **Build (aarch64)** — the same shape in `build_operation_node.ts`,
  `build_return_node.ts` (sret fail writes — the outer tag plus the
  origin-tagged member value; payload copies are aggregate-sized, not
  word-sized), `build_null_chain_value.ts` (slot/flag destinations),
  `build_node.ts`. Tag stores are 64-bit per the enum convention (a 32-bit
  store lets stack garbage ride the tag word into every downstream
  comparison). The p! initializer marks its binding heap-owned
  (`last_result_is_heap`) and the fail-path reclaim skips hoisted temps
  whose initializer is the in-flight `p!`; enum-payload walks recurse into
  enum-typed payloads (`free_payloads` families,
  `emit_enum_payload_frees_at`).
- **Build (JS)** — `!!` works (a tag test over the plain-object enum);
  postfix `!` degrades via the documented skip path
  (`__skip("postfix ! propagation")`) — the JS expression model has no
  statement seam for an early return, so the program keeps running and the
  expression evaluates to the zero value. Nullable chains and the `??`
  family are native-backend features; the JS backend does not lower them
  (see the JS entries in `FOLLOWUP.md`).
- **NIR** — `nir/from_ast.ts` carries the p! node into the aarch64 pipeline.

## Residuals and deliberate exclusions

- **Assignment-position lifting is deferred** (`var r = 0` against a
  declared `int ! FileError` binding does not lift): recorded in
  `FOLLOWUP.md`; revisit with a real consumer.
- **Foreign funcs cannot be fallible** (scalars/strings only) — unchanged;
  a permanent constraint of the FFI surface, not open work.
- **A nullable chain cannot be a `??` fallback** and **`??` needs a
  nullable left** — checker rules with guidance, not gaps (SPEC "Nullable
  chaining").
- The JS `p!` skip is a documented degradation, not a gap; the native
  semantics are the contract.

## History

Recorded as a design 2026-11-12 (the scratch notes the plan used to hold are
folded into the sections above) and shipped the same week: stages 1–3
(the `error` keyword, the `T ! E` sugar + lifting, `!!`, postfix `!`) on
2026-11-12; stage 4 (composition), stage 5 (flat arms — later replaced by
`try/catch`, 2026-11-13), stage 5b (anonymous
sets), stage 5c (unit results), and stage 5d (nullable chaining) immediately
after; the chain-value residuals (`f() ?? fb` leak, `y.v ?? fb` field
spelling, the `??` non-nullable-left rejection) closed 2026-11-13. The plan
retired into this reference the same day; the one deferred item
(assignment-position lifting) moved to `FOLLOWUP.md`.
