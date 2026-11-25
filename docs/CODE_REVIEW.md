# Nomen Language & Docs Review

Review date: 2026-11-24. Scope: `README.md`, `SPEC.md` (both rendered on the
site at `/readme` and `/spec`), with cross-checks against `NOMEN_AGENTS.md`,
`AGENTS.md`, `docs/` and the repo compiler.

**Update (2026-11-24, later the same day):** the documentation-consistency
findings (the former §1 — failing README/SPEC examples, contradictions,
stale content, broken links, README↔SPEC drift, convention breaks) were
**fixed in `README.md` / `SPEC.md` / `NOMEN_AGENTS.md` and removed from this
review**; the mirrored `test/readme/` and `test/spec/` copies were re-synced
in the same change. The coverage/definition gaps this surfaced (README
sections for the undocumented features, the SPEC Standard Library index,
integer overflow, argument evaluation order, doc comments, `nomen test`,
program entry and exit codes, globals, and the full operator-precedence
table) were filled the same day, so nothing is tracked here for them.
The §1.1 flow-facts work (early-return zero-guards, `&&` conjunct guards,
length non-negativity, and the `at_or_null` escape hatch — no `assert`, the
`if` guard IS the assertion) also landed and is removed below. So did the
`#destroy` soundness fix: a Copyable struct declaring `#destroy` is now
rejected with a named fix (`mv struct`), so a destructor can never run once
per copy — that finding is removed from §0 and §1.2. The doc/test drift is
closed in the same spirit: `test/docs_fences.ts` now compiles every non-error
fenced example in README.md / SPEC.md straight from the docs, so breaking an
example fails CI at its `file:line` + heading (error examples stay
hand-written in the feature suites). The §1.1 method-receiver work landed
the same day: instance methods must declare `self` (trait methods too),
`ref self` is required to write fields — including in `#init` — `#destroy`
must declare its receiver, capital-S `Self` is rejected in favour of the
`#self` placeholder (documented in the Traits section), and the static /
instance call forms are enforced at call sites (a receiver-less method is
static, called on the type; there is no `static` keyword) — §1.1 and the
§0 finding it fed are removed below, with error tests in
`test/structs.test.ts` / `test/traits.test.ts`. Four of the §1.7 lint
false positives landed the same way (the `for ref` const recommendation,
mutations through `ref` aliases, and calls counting as callee reads), and
the §1.7 `{}` suggestion landed with them, scoped: concrete value-struct
receivers now DERIVE `{}` (the lint fires only on `mv struct` setters, and
lifecycle receivers keep the permissive wildcard), so the section keeps the
remaining mv-body inference. The §1.5 precedence trap was fixed too: bitwise
`&`/`^`/`|` now bind tighter than the comparisons, so mixed expressions read
the way they look without parentheses, and the SPEC/README now state the
order outright (no other-language comparisons). One §1.6 item was resolved by investigation rather than
by an edit: struct members really do default to `pub` (verified
cross-namespace), and the System library's own house style is to spell
`pub var` on members anyway — so the examples were left explicit and match
the library. §1.2 Copyable-vs-`mv` ergonomics also landed and is removed
below: the Copyable verifier and the field-spelling rule now report as ONE
error naming both edits (`mark the struct `mv struct X`and declare the
field`mv T f``), the by-type × by-operation copy/move/borrow table it
asked for is in the SPEC ("Copies, Moves and Borrows"), with every cell
verified through the repo compiler, and the auto-infer-`mv` proposal was
considered and **rejected** (the declaration is the ownership contract —
`mv` stays spelled wherever a move happens). §1.3 Results, errors and
nullables is also resolved and removed below: the sibling-operator
diagnostics landed (`??` on a result now renders composed sets readably —
`Result<int, (A, B)>`, not the generated mono — and points at `!!`; `!!` on a
nullable points at `??`), and returning a plain value against an explicit
`out Result<T, E>` now teaches the lifting rule instead of a bare mismatch.
The `T ! E` spelling question closed itself: `nomen format` canonicalizes
`T ! E` by role, so the docs and the formatter agree. The match/catch
flattening ask is folded into the §2 match-patterns row (settled there, not
as a separate match-on-result sugar); the simple-result `??` leak was already
fixed when re-verified, and the error-context gap was already tracked in §2.
§1.4 Two spellings for one thing is also resolved and removed below: the
`let`/`->` question was settled as FULL SYMMETRY (breaking — one-liners take
`->`, block branches yield with `let`; `let` turned out to be load-bearing,
the only way a block branch yields, not a synonym), the `in` typo diagnostic
landed (`'in' is not Nomen — did you mean 'of'?`), and `T: type` retired in
favour of `type T` (breaking, named fix). The `Array<T>`/`T[]` pair is a
documented alias with a stated job (generic boundaries), so it stays; the
lambda arrow/block split already has its teaching diagnostic. §1.5's `for
ref` item was already done when re-verified — the SPEC states the
element-borrow semantics outright and the runtime tests pin them. §1.6
Types is also resolved and removed below: the widening rules are stated once
(SPEC's Type-to-Type Coercion is the canonical statement; Implicit Casting
points at it), the `ufloat` family is RETIRED (breaking — it enforced
nothing beyond its literals: `2.0 - 4.0` on a `ufloat` held `-2.0`; the fix
is `float*`), the vtable-word layout tradeoff is recorded as
considered-and-deferred in FOLLOWUP.md (SPEC's Layout Introspection section
already states the layout explicitly), and the untyped-`Channel` gap was
already §2's `typed Channel<T>` row.
What
remains below is the language-design and missing-features work. Line numbers
in the remaining sections refer to the working tree as of the original
review (before those fixes) and may have shifted.

**How claims were verified.** Every "compiles" / "fails" statement below was
run through the **repo** compiler (`npx tsx cli/src/index.ts check --in <file>`,
and `run --arch js|c` where runtime behaviour mattered) on scratch files that
wrap the snippet in `import System` + `pub func main`, the same way
`test/readme/_helpers.ts` does. The globally installed `nomen` was not used
because it is an older release.

Priorities:

- **P0**: a soundness or contract problem users hit directly.
- **P1**: a contradiction or stale statement that will mislead someone.
- **P2**: structure, consistency and polish.

---

## 0. Top findings

1. **The biggest missing features**: flow-sensitive facts for constraints
   (early return, `len >= 0`), match guards and richer patterns, generic
   methods, a typed `Channel<T>`, comparison-operator overloading, and `[]`
   index sugar. Section 2 has the full list.

---

## 1. Language design consistency

### 1.7 Lint false positives found while verifying (P2)

Four of these landed 2026-11-25 and are removed: a `for ref` iterable no
longer gets the const recommendation (following it is an error), a mutation
through a `ref` alias now marks the source binding (so `p` mutated only
through `q` stays silent), and a call reads its callee — a called closure
(`"\{f()}"`) and a `T: type` parameter constructed as `T()` count as used.
Regression tests live in `test/warnings.test.ts`.

- `Method receiver 'self' mutates only value-type storage — declare '{}'` used
  to fire on every simple `ref self` setter (README Counter, SPEC `readonly`
  Counter). Plain-struct receivers now DERIVE `{}` — every field a Copyable
  struct can declare is value storage, so the wildcard provably displaces
  nothing, the lint is silent, and the receiver composes with callers that
  narrow it through a declared `ref` parameter (which used to be an error).
  The lint now fires only on `mv struct` setters, where the set is
  load-bearing (lifecycle receivers keep the permissive wildcard, since
  `{}` would block forwarding `self` to wildcard helpers). What remains is
  the mv-body inference: if `{}` can be inferred from the body, infer it,
  rather than asking users to write `ref self {}`.

---

## 2. Missing features (vs Rust, Swift, Zig, Go, Kotlin)

Ordered by rough priority within each tier. "Effort" is a guess.

### Tier 1: high priority (blocks idiomatic code today)

| Feature                                                                                                                       | Peers                                                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                           | Effort |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Residual flow-fact narrowing (facts from `while` conditions, `else`-side narrowing after a guard)                             | Rust (NLL-style flow), Kotlin smart casts, Swift `guard`                | The core set landed 2026-11-24 (early-return zero-guards, `&&` conjuncts, `length >= 0`); these are the remaining shapes                                                                                                                                                                                                                                                                                                            | M      |
| `guard`/early-exit narrowing for nullables and results (`const v = x ?? return`, or `guard let`)                              | Swift `guard`, Kotlin `?: return`, Rust `let … else`                    | Pairs with the item above. Today the narrowing only flows into the `if` body                                                                                                                                                                                                                                                                                                                                                        | S–M    |
| Match guards, or-patterns, nested/struct patterns, range patterns (`case .rect(w, h) if w == h`, `case .a, .b`, `case 1..10`) | Rust, Swift, Kotlin `when`                                              | `match` is central, but currently it handles only one level of case + bind. That's why composed errors need three nested matches, and why result handling has no flat "success + each error" form (the former §1.3 ask: nested patterns — `case .fail(.LoadError(.timeout))` — collapse the composed nesting; settle it HERE rather than as a separate match-on-result sugar, and re-check the `.ok`-sibling form after this lands) | M      |
| Typed `Channel<T>`                                                                                                            | Go, Rust mpsc, Kotlin channels                                          | The untyped `uint64` channel plus `send_string` doesn't fit a typed language with `Sendable`                                                                                                                                                                                                                                                                                                                                        | M      |
| Generic methods (`func map<U> = (self, func (T, out U) f, out List<U>)`)                                                      | All peers                                                               | `SPEC.md:3860`: "there are no generic methods". This blocks `map`/`filter`/`fold` on collections                                                                                                                                                                                                                                                                                                                                    | M–L    |
| Comparison and ordering overloading (`#op_lt` / a `Comparable` trait), unary `-`, index operators                             | Rust `PartialOrd`/`Index`, Swift `Comparable`, Kotlin `compareTo`/`get` | Only arithmetic and `==` are overloadable. Sorting user types and generic `max`/`min` need ordering                                                                                                                                                                                                                                                                                                                                 | S–M    |
| `[]` index sugar for `.at`/`.set`                                                                                             | All peers                                                               | `arr.at(i)` and `grid.at(1).at(0)` are verbose. `p[i]` already exists inside `unsafe`, so the syntax is free                                                                                                                                                                                                                                                                                                                        | S      |

### Tier 2: medium priority

| Feature                                                                                         | Peers                                                         | Rationale                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defer` / `errdefer`                                                                            | Zig, Go, Swift                                                | `#destroy` covers types, but not ad-hoc cleanup (unlock, restore state) at a call site, especially with `!` early returns                                                   |
| Iterator protocol for user types and lazy adapters                                              | Rust `Iterator`, Swift `Sequence`, Kotlin `Sequence`          | `Enumerable` exists, but FOLLOWUP lists for-of gaps for collections. Needed with generic methods                                                                            |
| `while let` / `if case` binding (`if .some(v) = opt { … }`)                                     | Rust, Swift                                                   | Avoids a full `match` for single-case checks                                                                                                                                |
| Labeled `break`/`continue`                                                                      | Rust, Go, Kotlin, Swift, Zig                                  | Nested loops currently need flags                                                                                                                                           |
| Defined integer overflow semantics, plus `wrapping_*`/`checked_*` ops                           | Rust, Zig, Swift                                              | Unspecified today (`uint8` 200 + 100 compiles). A memory-safety-focused language should pick trap-on-overflow (Swift/Zig debug) or document wrap                            |
| Trait-typed struct fields, and `List<Trait>` heterogeneous collections                          | All peers                                                     | `SPEC.md:2093`: "A trait-typed field is not supported yet". It's a basic OO and plugin pattern                                                                              |
| Trait associated types and constants, and default methods (beyond the reflection defaults)      | Rust, Swift                                                   | Needed for generic containers and protocols such as `Iterator<Item>`                                                                                                        |
| Error context and chaining (payload structs, an `error` trait with `message()`)                 | Rust `Error`/`anyhow`, Swift `Error`, Zig error return traces | Today errors carry no source or message unless every case has a payload                                                                                                     |
| Mutable closure capture (by reference, or a `ref` capture of a `var` that outlives the closure) | Swift, Kotlin, Rust `FnMut`                                   | Captures are copied at creation (verified: a later `count = 5` isn't seen), and `ref`/`var` borrows can't be captured at all. Callbacks that update state need a workaround |
| Unicode string iteration (code points, graphemes) and a 32-bit `rune`/`Char`                    | Go `rune`, Swift `Character`, Rust `char`                     | `char` is 8-bit and `.length` counts bytes. The JS backend uses UTF-16 (FOLLOWUP), so behaviour already diverges                                                            |
| `assert` / `debug_assert` as language-level statements that also feed constraint facts          | Rust, Zig, Swift                                              | Testing story, plus the constraint escape hatch above                                                                                                                       |

### Tier 3: nice to have, or later

| Feature                                                                                                       | Peers                                 | Rationale                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package manager / dependency resolution (`package.jsonc` exists; no registry or versioned deps documented)    | Cargo, SwiftPM, Go modules, Zig build | Needed for an ecosystem                                                                                                                                         |
| User-level FFI (`foreign func` is System-library-only, `SPEC.md:1786`)                                        | All peers                             | Users can't bind their own C libraries without forking `core/`                                                                                                  |
| Comptime functions (call an ordinary function at compile time) and `@Type`-style construction                 | Zig comptime, Rust `const fn`         | Noted as future work (`SPEC.md:3667`). The reflection surface is already rich                                                                                   |
| Named and keyword arguments at call sites                                                                     | Swift, Kotlin                         | `Bounded(5, 50)` and `Circle("C", 25, 70, 15)` positional constructors get hard to read. `async(timeout: 500)` already uses the syntax                          |
| Hygienic macros / derive for user traits                                                                      | Rust, Swift macros                    | Partly covered by `#for` + reflection defaults                                                                                                                  |
| Async I/O integration (fibers parking on sockets and files, not just channels)                                | Go, Kotlin coroutines, Zig            | `Fiber` parks on `Channel`/`Task`, but the `Stream` modules aren't documented as fiber-aware                                                                    |
| Struct update by value for mv structs, and `copy`-with overrides (`[ .. x, f = 1 ]` exists for value structs) | Kotlin `copy`, Rust `..base`          | Extend the existing feature to owning types                                                                                                                     |
| Visibility per type member (`private` field within a struct)                                                  | All peers                             | `private` was retired. Members default to `pub`, so there's no way to hide a struct field from other code in the same namespace (`readonly` covers writes only) |

---

## 3. Suggested order of work

1. Work through the Tier 1 features in §2 (the former §1.3 result-match
   flattening ask rides on the match-patterns row).
