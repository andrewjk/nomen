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
`if` guard IS the assertion) also landed and is removed below. One §1.6 item was resolved by investigation rather than
by an edit: struct members really do default to `pub` (verified
cross-namespace), and the System library's own house style is to spell
`pub var` on members anyway — so the examples were left explicit and match
the library. What remains below is the language-design and
missing-features work. Line numbers in the remaining sections refer to the
working tree as of the original review (before those fixes) and may have
shifted.

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

1. **Design: a Copyable `struct` may declare `#destroy`, and copying it runs
   the destructor twice** on the C backend (verified: it prints
   `destroy 3` twice). The JS backend doesn't run it at all. The README and
   SPEC `Transaction` example shows exactly this resource-handle pattern on a
   plain `struct`.
2. **Static and instance methods look alike.** A method with no `self`
   parameter is static (`SPEC.md:4551`, "// static"). Yet the compiler
   accepts trait methods written without `self`
   (`to_string = (out string)`) and dispatches them on instances — whether a
   method is static depends on context. The docs were updated to always
   spell `self` on instance methods, but the compiler rule is still
   implicit.
3. **The biggest missing features**: flow-sensitive facts for constraints
   (early return, `len >= 0`), match guards and richer patterns, generic
   methods, a typed `Channel<T>`, comparison-operator overloading, and `[]`
   index sugar. Section 2 has the full list.

---

## 1. Language design consistency

### 1.1 Methods: `self` spelling and static methods (P1)

- A method with no `self` is static (`Task.current_cancelled`,
  `SPEC.md:4551`). But the compiler also accepts trait methods written
  without `self` (`to_string = (out string)`) and dispatches them on
  instances — whether a method is static depends on context. (The docs were
  updated to always spell `self`; the compiler rule is still implicit.)
- `self` is read-only, `ref self` is mutable, and `#init` takes either (and
  writes to it in both cases). `#destroy` takes nothing but uses `self`.
- There's no `static` keyword and no `Self` documentation, yet
  `SPEC.md:1034` uses `#self other, out Self`, which compiles but is
  explained nowhere outside comptime.

Recommendation: always require `self` for instance methods. Mark static
methods explicitly (`static func`, or `Type.func`). Document `Self` and the
`#self` placeholder in the Traits section.

### 1.2 Copyable vs. `mv`, and destructors (P0 design)

- A plain `struct` can declare `#destroy`, and copies duplicate it. On the C
  backend the destructor runs once per copy (`destroy 3` printed twice,
  verified). On the JS backend it doesn't run at all, which is a backend
  divergence. Rust forbids `Copy + Drop` for this reason. Recommendation:
  `#destroy` implies `mv struct`, or the verifier rejects it ("Copyable type
  cannot have #destroy").
- `string` is mv, but a plain `struct` can't hold one. Newcomers hit this
  immediately (`struct Person { var string name }` produces two errors:
  "cannot be Copyable" _and_ "declare it 'mv string name'"). Two
  improvements: (a) emit one error with one fix; (b) consider auto-inferring
  `mv struct` for structs with owning fields, reserving the explicit keyword
  for public API, which matches the "implicit with type inference" philosophy
  stated at `SPEC.md:2083`. Today the rule is the reverse: the `mv` on the
  field _and_ on the struct are both mandatory, and inferred-type fields
  (`var label = ""`) are rejected.
- Copying semantics vary by type in ways that are hard to predict. Bare
  struct assignment copies; string assignment is an error unless `mv` or
  `.copy()`; closure capture copies scalars but **moves** strings
  (`SPEC.md:1885`); tuple and array element reads need `.copy()`; struct
  destructuring binds views, but anonymous-struct destructuring of a string
  field errors. A single table ("what happens when I write `x = y` / pass /
  capture / destructure, by type kind") would help, both as documentation and
  as a design consistency check.

### 1.3 Results, errors and nullables (P1)

The design is mostly coherent (`?.`/`??` mirror `!`/`!!`), with a few sharp
edges:

- **`match` vs `try … catch` split.** `match` arms must be `.ok`/`.fail`, and
  `catch` arms must be error cases. So the natural "handle success and each
  error in one place" needs `match` + nested `match` (`SPEC.md:1288-1295`,
  `:1404-1421`, three levels deep for a composed set). Allow `match` on a
  result to flatten error cases (`case .ok(v)`, `case .notfound`), or give
  `try … catch` an optional `else`/`ok` arm. The old CLI's behaviour (it
  accepts flattened arms) suggests users already expect this.
- **Unit results can't use `try` in expression position**, while `T ! E` can.
  This is reasonable, but the statement form differs (no `->` arms), and that
  asymmetry is easy to trip on.
- **Errors must be `error` enums**: no payload-carrying struct errors and no
  `error` trait for context or messages. There's also no way to wrap a lower
  error with context without declaring a composed set.
- **Diagnostics that leak internals**: `x ?? 4` on a result reports
  `'Result_int__AnonEnum_notfound__offline' is not nullable` (verified).
  `a !! 3` on an `int?` reports "Variable 'a' may be null" rather than "use
  `??` for nullables". Both should point at the sibling operator.
- **Spelling**: SPEC writes `out T ! E` while `nomen format` writes `T !E`
  (FOLLOWUP). Decide which and make the formatter and docs agree.
- **Two ways to write a Result type**: `out Result<T,E>` (no lifting) vs
  `out T ! E` (lifting) (`SPEC.md:1282`). The subtle semantic difference
  between two spellings of the same type is a trap. Lift in both cases, or
  reject `Result<…, error-enum>` in `out` position in favour of `!`.

### 1.4 Two spellings for one thing (P2)

- `let` vs `->` in branches (`SPEC.md:2418-2447`). Two keywords with
  identical meaning, plus two paragraphs of rules about where `let` is _not_
  allowed. Consider dropping `let`.
- `type T` vs `T: type` (`SPEC.md:3784`), and `func f<T>(T seed)` with an
  unused value only to bind `T` (`:587`, `:3376`) vs `type T`.
- `Array<T>` vs `T[]`; `T[N]` fixed arrays vs `uint64[2048]` stacks.
- Block vs arrow lambdas need different keywords (`func (x, out int) { … }`
  vs `(x) => …`), and `(x) => { … }` is a syntax error (`SPEC.md:1874-1877`).
  This surprises JS, Kotlin and Swift users.
- `for x of xs` but `#for field of …` and ranges `0..n` vs `0 .. n`. These
  are fine, but `in` is a common typo (see the README bug), so give it a
  dedicated diagnostic ("did you mean `of`?").

### 1.5 Statement and expression forms (P2)

- `switch` in statement position accepts value arms (`case x > 100 ->
"big"`, `SPEC.md:2314-2318`) and silently discards the value (verified, no
  warning).
- `else if` gives only `Expected {` (verified). Given how strongly the docs
  push `switch`, the parser should say "`else if` isn't supported — use
  `switch`".
- **C precedence trap preserved**: `&`, `|` and `^` bind looser than `==`
  (`SPEC.md:2578-2581`), so `flags & X == X` parses as `flags & (X == X)`.
  The README works around it with parentheses (`:543`). New languages (Go,
  Swift, Rust) fixed this. It's worth fixing before 1.0, or at least making
  mixed bitwise/comparison expressions without parentheses an error.
- `for ref p of points` gives a "mutable copy … written back at the end of
  the iteration" (`SPEC.md:2356`). A `ref` that is really a copy-in/copy-out
  differs from `ref` parameters, and aliasing inside the loop body is
  surprising. Document this clearly, or make it a true element borrow.

### 1.6 Types (P2)

- `ufloat` family: unsigned floats are unusual, and their semantics
  (negative results from subtraction? NaN?) aren't specified.
- Implicit widening rules are stated twice with slightly different wording
  (`SPEC.md:2776-2779` and `:3142-3146`).
- `Channel` is untyped (`uint64` values plus `send_string`) because "Nomen
  values are pointer-sized" (`SPEC.md:4071`). That's out of step with the rest
  of a statically typed language. See §2.
- Struct layout puts an 8-byte vtable word in **every** struct
  (`SPEC.md:3727`), so `Pair { int64, int32 }` is 24 bytes and
  `offset_of(Pair, "b") == 16`. This is a performance and FFI design choice
  worth stating explicitly (and possibly reconsidering for structs with no
  trait conformance).

### 1.7 Lint false positives found while verifying (P2)

These make doc examples noisy and will train users to ignore warnings:

- `Variable 'points' is never changed, consider using const` on an array used
  by `for ref`. Following the advice is an error (`'ref' iteration requires a
'var' array`).
- `Variable 'p' is never changed` when `p` is mutated through a `ref` alias
  `q` (SPEC `:528-530` example).
- `Value 'f' is never used` for a closure that **is** called (`"\{f()}"`).
- `Parameter 'T' is never used` for a `T: type` parameter used as `T()`.
- `Method receiver 'self' mutates only value-type storage — declare '{}'` fires
  on every simple `ref self` setter (README Counter, SPEC `readonly`
  Counter). If `{}` can be inferred, infer it, rather than asking every user
  to write `ref self {}`.

---

## 2. Missing features (vs Rust, Swift, Zig, Go, Kotlin)

Ordered by rough priority within each tier. "Effort" is a guess.

### Tier 1: high priority (blocks idiomatic code today)

| Feature                                                                                                                       | Peers                                                                   | Rationale                                                                                                                        | Effort |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Residual flow-fact narrowing (facts from `while` conditions, `else`-side narrowing after a guard)                             | Rust (NLL-style flow), Kotlin smart casts, Swift `guard`                | The core set landed 2026-11-24 (early-return zero-guards, `&&` conjuncts, `length >= 0`); these are the remaining shapes         | M      |
| `guard`/early-exit narrowing for nullables and results (`const v = x ?? return`, or `guard let`)                              | Swift `guard`, Kotlin `?: return`, Rust `let … else`                    | Pairs with the item above. Today the narrowing only flows into the `if` body                                                     | S–M    |
| Match guards, or-patterns, nested/struct patterns, range patterns (`case .rect(w, h) if w == h`, `case .a, .b`, `case 1..10`) | Rust, Swift, Kotlin `when`                                              | `match` is central, but currently it handles only one level of case + bind. That's why composed errors need three nested matches | M      |
| Typed `Channel<T>`                                                                                                            | Go, Rust mpsc, Kotlin channels                                          | The untyped `uint64` channel plus `send_string` doesn't fit a typed language with `Sendable`                                     | M      |
| Generic methods (`func map<U> = (self, func (T, out U) f, out List<U>)`)                                                      | All peers                                                               | `SPEC.md:3860`: "there are no generic methods". This blocks `map`/`filter`/`fold` on collections                                 | M–L    |
| Comparison and ordering overloading (`#op_lt` / a `Comparable` trait), unary `-`, index operators                             | Rust `PartialOrd`/`Index`, Swift `Comparable`, Kotlin `compareTo`/`get` | Only arithmetic and `==` are overloadable. Sorting user types and generic `max`/`min` need ordering                              | S–M    |
| `[]` index sugar for `.at`/`.set`                                                                                             | All peers                                                               | `arr.at(i)` and `grid.at(1).at(0)` are verbose. `p[i]` already exists inside `unsafe`, so the syntax is free                     | S      |

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

1. Make `#destroy` imply `mv` (§1.2). This is a soundness fix, not just docs.
2. Decide the method receiver and static-method rule (§1.1), and the
   result-`match` flattening question (§1.3). Both affect many examples, so
   settle them before more docs are written.
3. Work through the Tier 1 features in §2.
4. Generate `test/readme/` and `test/spec/` inputs from the docs' fenced
   blocks (extract by heading), keeping hand-written expectations only for
   the blocks marked as errors — the doc/test drift this review found (and
   hand-fixed) then fails CI instead of hiding.
5. Rename `core/System/ClassBuffer.nm` — the last retired-`class` name in
   the tree.
