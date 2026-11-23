# Nomen Language & Docs Review

Review date: 2026-11-24. Scope: `README.md`, `SPEC.md` (both rendered on the
site at `/readme` and `/spec`), with cross-checks against `NOMEN_AGENTS.md`,
`AGENTS.md`, `docs/` and the repo compiler. This is a review only — no docs or
compiler code were changed.

**How claims were verified.** Every "compiles" / "fails" statement below was
run through the **repo** compiler (`npx tsx cli/src/index.ts check --in <file>`,
and `run --arch js|c` where runtime behaviour mattered) on scratch files that
wrap the snippet in `import System` + `pub func main`, the same way
`test/readme/_helpers.ts` does. The globally installed `nomen` was not used
because it is an older release. Line numbers refer to the working tree on the
review date, which includes uncommitted edits to both files.

Priorities:

- **P0**: a published example is wrong (it fails to compile, or the docs
  contradict what the compiler does) on a page users read first.
- **P1**: a contradiction or stale statement that will mislead someone.
- **P2**: structure, consistency and polish.

---

## 0. Top findings

1. **Five README examples fail to compile on their own** (P0): variadic
   `sum` (`README.md:181-189`), `Point.translate` on a `const`
   (`README.md:289-290`), the `for i in` loop in Constraints
   (`README.md:661`), anonymous-struct destructuring of a `string` field
   (`README.md:699-701`) and `take` with no return (`README.md:882-884`).
   `test/readme/` misses them because the test copies have drifted from the
   README text (for example, the test uses `var p`, while the README uses
   `const p`).
2. **The spec contradicts itself about constraints** (P0). `SPEC.md:274`,
   `README.md:637` and `NOMEN_AGENTS.md` say constraints are "only checked when
   the value is a compile-time constant". In fact any runtime argument that
   can't be proven gives the error `Parameter constraint cannot be verified`
   (verified). `SPEC.md:2671-2700` describes the real behaviour, but only for
   division.
3. **`match` on a unit result with an error-side arm** (`SPEC.md:1314-1319`)
   is rejected by the compiler. The spec's own rule at `SPEC.md:1523` forbids
   it.
4. **Generics are described three different ways**: "no monomorphization"
   (`SPEC.md:547`), "monomorphized type" (`SPEC.md:1167`), and "one
   specialized copy per instantiation" while also "type-erased"
   (`README.md:603-605`).
5. **Retired `class` still appears** in SPEC. Auto-free lists "Classes"
   (`SPEC.md:3159`), `WeakHandle` says "The tracked type must be a CLASS"
   (`SPEC.md:4196`), and see also `SPEC.md:2754` and `SPEC.md:3747`. Two
   "Stage-1/Stage-2 limits" paragraphs (`SPEC.md:3720`, `SPEC.md:3913`) say
   things that the sections above them have since made untrue.
6. **Design: a Copyable `struct` may declare `#destroy`, and copying it runs
   the destructor twice** on the C backend (verified: it prints
   `destroy 3` twice). The JS backend doesn't run it at all. The README and
   SPEC `Transaction` example (`README.md:843`, `SPEC.md:480`) shows exactly
   this resource-handle pattern on a plain `struct`.
7. **Static and instance methods look alike.** A method with no `self`
   parameter is static (`SPEC.md:4551`, "// static"). Yet the
   `Stringable`/`Circle` examples (`README.md:368-383`, `SPEC.md:1085-1100`)
   declare `to_string = (out string)` and call it on an instance. They also
   redeclare `Stringable`, which **collides with `System`'s own `Stringable`**
   ("Trait already declared") as soon as `import System` is present.
8. **The biggest missing features**: flow-sensitive facts for constraints
   (early return, `len >= 0`), match guards and richer patterns, generic
   methods, a typed `Channel<T>`, comparison-operator overloading, and `[]`
   index sugar. Section 3 has the full list.

---

## 1. Documentation consistency and quality

### 1.1 README examples that fail (P0)

All of these were checked with the snippet as written, plus `import System`
and a `main` wrapper.

| Where                                   | Snippet                                                       | Compiler says                                       | Fix                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `README.md:181-189` Functions, variadic | `while i < numbers.length; i += 1` with no `i` declared       | `Unknown value: i` ×3                               | add `var i = 0`, or use `for n of numbers`. Also `sum(1, 2, 3)    //` has an empty comment; it should say `// 6`         |
| `README.md:289-290` Structs             | `const p = Point(3, 4)` then `p.translate(1, 1)` (`ref self`) | `Update to const: p`                                | `var p`. The same bug is in `SPEC.md:2040-2041` and `SPEC.md:1818-1820` (`const v`, `v.scale(4)`), both verified failing |
| `README.md:661` Constraints             | `for i in 0 .. nums.length`                                   | `Expected of`                                       | `for i of 0..nums.length` (verified to compile, and the bounds fact discharges `.at(i)`)                                 |
| `README.md:699-701` Anonymous structs   | `var [name, x, y] = p` where `name` is a string               | `cannot copy 'string' out of field 'name' by value` | drop `name`, use `mv`, or show the error on purpose                                                                      |
| `README.md:882-884` Ownership           | `func take = (mv Box b, out int)` with no `return`            | `Missing return`                                    | remove `out int`                                                                                                         |

Snippets that fail only because they rely on names from an earlier block
(Strings uses `name`/`age`; Pattern Matching uses `shape`; Error Handling
uses `fetch`) pass when combined with that context. That's acceptable, but
it's worth saying once at the top of "Language Overview" that snippets build
on each other.

`README.md:651-664` mixes a deliberate error (`nums.at(0)`, "not ok") into a
function that's otherwise meant to compile. Readers who paste it get an
error. Split it into "ok" and "error" blocks, as SPEC does elsewhere.

**Root cause: the mirror tests have drifted.** `test/readme/structs_classes.test.ts:22`
uses `var p = Point(3, 4)` where the README says `const p`. The AGENTS.md rule
("keep these in sync") isn't enforced. Recommendation: generate the
`test/readme/` and `test/spec/` inputs from the fenced blocks (extract by
heading, as this review did with a 20-line Node script), and keep hand-written
expectations only for the blocks marked as errors. Then any drift fails CI.
Note also that `compile_module` passes `allow_internal: true`
(`test/spec/_helpers.ts:44`), so SPEC examples that use `Buffer` and other
internals (for example `SPEC.md:2958-2973`, `UserList`) pass tests but fail
for users.

### 1.2 SPEC examples that contradict the compiler or SPEC itself (P0/P1)

| Where                                         | Problem                                                                                                                                                                                                                                                                                                | Verified |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `SPEC.md:274` "How Constraints Are Evaluated" | Says unknown values are "not evaluated and no error is produced". In fact a runtime argument errors with `Parameter constraint cannot be verified` (`restricted(line.length)`). Same wrong claim in `README.md:637` and `NOMEN_AGENTS.md` ("Only evaluated when the value is a compile-time constant") | yes      |
| `SPEC.md:1314-1319` Unit Results              | `match close(path) { case .ok … case .notfound … }`. Rejected: `'case .notfound' addresses the error side … handle the error side with 'try ... catch'`. Conflicts with `SPEC.md:1523`                                                                                                                 | yes      |
| `SPEC.md:1141`                                | "Shorthand is only for simple case access — cases with associated data must use the full form". False: `return .circle(3)` and `var Shape s = .rect(1, 2)` compile, and SPEC itself uses `.error("not a number")` (`:840`) and `.fail("not a number")` (`:1175`)                                       | yes      |
| `SPEC.md:1182-1186`                           | "the full form uses the generic name with explicit type arguments", but the example is `Option.some(4)` with no type arguments                                                                                                                                                                         | —        |
| `SPEC.md:1085-1100` / `README.md:368-383`     | Redeclares `trait Stringable`. With `import System` (which every real program has) this fails: `Trait already declared: Stringable`, reported at a bogus location (`31:1` in a 16-line file). Rename it to something like `Describable`                                                                | yes      |
| `SPEC.md:244`                                 | `var int y: x < 100` probably meant `y < 100`. As written, `Bounded(5, 500)` compiles. The same block also redeclares `const b`                                                                                                                                                                        | yes      |
| `SPEC.md:462-466` Initializers                | `pub int x` fields (no `var`) give 9 parse errors (`Visibility can only be set for …`)                                                                                                                                                                                                                 | yes      |
| `SPEC.md:1508-1518`                           | `case ParseError.corrupt` refers to a case that `ParseError` (`:1380`) doesn't declare                                                                                                                                                                                                                 | —        |
| `SPEC.md:2327`, `:2344`, `:2352`              | `Console.write(x)` / `Console.write(item)` with an `int`. Rejected: `Type mismatch in param: int (expected string)`. Use `"\{x}"`                                                                                                                                                                      | yes      |
| `SPEC.md:2224`                                | "An `if`/`else` with no `else` used as an expression yields `void` when taken and `null`-like when skipped" doesn't parse as English; say "an `if` used as an expression requires an `else`"                                                                                                           | —        |
| `SPEC.md:1986` vs `:2261` vs `:2293`          | Expression `match` "requires `case _` on non-exhaustive types", then "A `case _` arm is required when using `match` as an expression value" (unconditional), while enum and `bool` matches are exhaustive without one. Pick one rule                                                                   | —        |
| `SPEC.md:3909-3911` Attributes                | "an attribute name that matches a library type … links it exactly as if the source had mentioned it". `AGENTS.md` says the opposite: the type-link scan skips attribute-name tokens                                                                                                                    | —        |
| `SPEC.md:3969` Json                           | `@rename("user")` is placed on the struct, but JSON `@rename` is documented as a field-level key (`:3962`)                                                                                                                                                                                             | —        |
| `SPEC.md:4613-4616`                           | "instance methods at x1" vs "Instance methods: self in x0"                                                                                                                                                                                                                                             | —        |
| `NOMEN_AGENTS.md` (Memory modifiers)          | "A `ref` alias is not reassignable", but `SPEC.md:535` says reassigning re-points it, and `q = Box<Node>(Node(1))` compiles                                                                                                                                                                            | yes      |
| `NOMEN_AGENTS.md` table                       | `out T`: "output parameter, assigned inside the function". `out` is the return slot, not an output parameter                                                                                                                                                                                           | —        |

### 1.3 Stale content (P1)

- **Retired `class`:** `SPEC.md:3159` (Auto-free lists "Classes"),
  `SPEC.md:4196` ("tracked type must be a CLASS"), `SPEC.md:2754` ("trait
  or class payload"), `SPEC.md:3747` ("a class the heap pointer"). The
  reserved-word list (`SPEC.md:21`) still lists `class` without saying it is
  retired, which only `:35` explains. `core/System/ClassBuffer.nm` keeps the
  old name.
- **Overview omits JS:** `SPEC.md:5` says "compiles to C or AArch64 assembly".
- **String representation:** `SPEC.md:60` says "C-style null-terminated
  string". Strings are fat `(ptr, len)` values everywhere (AGENTS.md "String
  convention", `SPEC.md:3746` "16-byte fat pair"). Also, `char` is "8-bit"
  (`:61`), so `"héllo".length` is a byte count. Say so.
- **Stage notes left in place:** `SPEC.md:3720` says "`#for` is
  body-scope only (whole-declaration generation is a later stage)", directly
  after the Declaration Generation section (`:3598`). `SPEC.md:3913` says
  "pragmas are … not inside struct/trait bodies" and "`META` exists only
  inside pragma conditions", which `:3292-3321` and `:3369` contradict. Delete
  both paragraphs. `:3721` also uses the old name "raw `#arch` blocks".
- **Old link text:** `SPEC.md:1203` and `:1539` say "see [Strict
  Enums](#checked-enums)". The section is called "checked Enums" (also note the
  lowercase heading at `:1205`).
- **Internal plan jargon in a user-facing spec:** "STRUCT_PLAN_3 B1"
  (`:2047`), "B1a" (`:2072`), "STRUCT_PLAN_3 Phase R — the shape menu"
  (`:4032`, `:4063`, `:4258`, `:4543`), "line 422" (`:124`, a line number that
  has moved), "stage 5" (`:3916`).
- **Code Style section** (`SPEC.md:4618-4624`) describes the TypeScript
  compiler's style (`FunctionNode`, `COMPOUND_SYMBOLS`, `^[../]` import
  sorting). It doesn't belong in the language spec. Replace it with what
  `nomen format` does (tabs, 100 columns, sorted imports, implicit types).
- `SPEC.md:4541`: "`Task<uint64>` for uint64-returning functions,
  `Task<uint64>` for void functions" is a copy-paste slip.

### 1.4 Broken or fragile links (P1)

- `SPEC.md:3169` → `MEMORY.md` and `SPEC.md:4095` → `ASYNC.md` are broken.
  Both live in `docs/`. Other SPEC links use `docs/…` (`:3177`).
- `SPEC.md:542` and `:2138` link `#owning-structs-1`. This relies on
  GitHub-style de-duplication of two headings that differ only in case ("Owning
  Structs" `:493`, "Owning structs" `:2045`). Check that the site renderer
  produces the same slug, or rename one heading. `:2138` links to the section
  it is in.
- Other duplicate headings make the site's table of contents ambiguous:
  "Structs" (`:403` "Struct Types" and `:2017`), "Task" (`:3987` and `:4537`),
  "Destructuring" (`:679` and `:866`), "Arrays" (`:2534`) vs "Array Types"
  (`:77`), Implicit Casting (`:2774`) vs Type-to-Type Coercion (`:3132`),
  which say the same thing twice.
- `SPEC.md:1984` is titled "Method/Function Calls as Expressions" but covers
  `match`/`switch`/`if` expressions.

### 1.5 README ↔ SPEC disagreements and drift (P1)

| Topic                 | README                                                                                       | SPEC                                                           | Note                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generics storage      | "type-erased … one specialized copy per instantiation (`Box<int>` → `Box_int`)" (`:603-605`) | "no monomorphization" (`:547`); "monomorphized" (`:1167`)      | The README sentence also contradicts itself. Describe what actually happens once: monomorphized, with a uniform 8-byte slot on aarch64                                    |
| `#init` receiver      | `(self, int handle)` (`:846`)                                                                | `(ref self, int x, int y)` (`:467`, `:483`, `:1830`)           | `(self, …)` compiles but warns: "declare '{}'". Pick one spelling                                                                                                         |
| `#destroy`            | `func #destroy = ()`, no `self`                                                              | same (`:487`)                                                  | `self` is used implicitly. Every other method spells `self`                                                                                                               |
| Trait method receiver | `Printable.to_string = (self, out string)` (`:322`)                                          | `Stringable.to_string = (out string)` (`:1086`)                | See §2.2                                                                                                                                                                  |
| Concurrency entry     | `async nursery { nursery.start(Thread(fetch(1))) }` (`:786`)                                 | `async { Thread(fetch(1)).start() }` (`:4427`)                 | README opens with the escape-hatch form. Show the plain form first                                                                                                        |
| Task result           | `t.result_uint64()` (`:806`), `f.result()` (`:823`)                                          | both                                                           | Explain why there are two, or drop `result_uint64` from the intro                                                                                                         |
| Fiber example         | inside `async { }` (`:821`)                                                                  | no nursery (`:4335`)                                           | —                                                                                                                                                                         |
| Platforms             | CLI: `macos, ios, linux, android, windows, web` (`:100`)                                     | `META.platform`: `"macos"`, `"linux"` or `"windows"` (`:3266`) | —                                                                                                                                                                         |
| Float types           | `float`, `float32`, `float64` (`:118`)                                                       | adds `ufloat`, `ufloat32`, `ufloat64` (`:59`)                  | README omits the unsigned floats (an unusual feature, see §2.7)                                                                                                           |
| Running               | `nomen --in path/to/program.nm` (`:57`)                                                      | —                                                              | Verified: with no command, the CLI prints help and exits. It should be `nomen run --in …`                                                                                 |
| CLI options           | table (`:93-104`)                                                                            | —                                                              | Omits `--release`/`-r` and `--fast-math`, which exist in `cli/src/args.ts:53-55` and `docs/CLI.md`. The text "Top-level options:" (`:80`) sits above the _commands_ table |

### 1.6 Examples that break the repo's own conventions (P2)

- **camelCase** `makeFive` (`SPEC.md:300`, `:1687`) breaks the snake_case
  convention.
- **Redundant annotations**, which `nomen check` warns about and `nomen
format` removes: `const bool same = a == b` (`README.md:400`,
  `SPEC.md:2192`), `const int v = unwrap(b)` (`README.md:600`),
  `const uint64 r = t.result_uint64()` (`README.md:806`), `const string name =
"Alice"` and `var int age = 30` (`SPEC.md:1561-1562`, which teach
  annotations as the default), and literal blocks such as
  `SPEC.md:2471-2491`.
- **Redundant `pub` on members**: `SPEC.md:3110` says struct members default
  to `pub`, yet nearly every example writes `pub var int x`. Either members
  aren't really `pub` by default, or the examples teach noise.
- **Modifier order**: `mv pub struct User` (`SPEC.md:3875`) vs `pub mv struct`
  (`:3613`, `:4546`).
- **Placeholders** `{ ... }` in code blocks (`SPEC.md:231`, `:318`, `:412`,
  `:555`, `:2064`, `:3030`) won't compile. Use a comment body.
- **Undefined names**: `Cat` (`SPEC.md:2765`), `Math.power` (`:3071`),
  `users` (`:2970`), `Animal`/`Named`/`Dog` (`:1041-1049`), `should_exit`
  (`:2384`).
- **Name collisions with `System`**: user-defined `Box`/`Box<T>`
  (`README.md:570`, `:872`), `Result` (`SPEC.md:1146`, `:2298`), `Counter`
  defined three different ways, and `Stringable` (above). They work in some
  contexts, but they teach shadowing of core names.
- **Owning-field spelling is inconsistent**: `SPEC.md:2081-2083` says
  `string` fields require `mv`, and `var label = ""` in an `mv struct` is
  indeed rejected (`field 'label' owns memory — declare it 'mv string label'`,
  verified). Yet `SPEC.md:582-585` (`Item`), `:3813-3816` (`Sample`) and
  `:3969-3974` (`Account`) all write inferred `var x = ""` string fields.
- **Indentation**: README and SPEC examples use 4 spaces. `nomen format`
  emits tabs, and `SPEC.md:3970` (Json) is tab-indented. Choose one for docs.
- **Markdown list breakage** at `SPEC.md:2696-2707` and `:3220-3222`: wrapped
  inline code at column 0 breaks the bullet structure when rendered.

### 1.7 Structure and coverage gaps (P2)

- **README duplicates itself**: "Owning Structs" (`:294-313`) and "Ownership &
  Borrows" (`:862-870`) open with the same paragraph. Merge them, or keep a
  one-line pointer.
- **Features with no README section**: Higher-Order Functions/lambdas/closures,
  FFI, Compile-Time JSON, `#if`/`#for`/attributes (only a link), `mv enum`,
  `Box<T>`, `readonly`, imports and visibility.
- **The SPEC Standard Library section** (`:3920`) covers Console, Ansi, Json,
  Task, Mutex and Channel, but not `List`, `Map`, `Set`, `StableList`,
  `StringBuilder`, `Math`, `Time`, `Random`, `Option`, or the
  `Stream/File/Http/Directory` modules in `core/System/`. Even one line per
  type, with a link to `nomen docs` output, would help.
- **Things the spec never defines**: integer overflow behaviour (`uint8`
  200 + 100 compiles, with no stated wrap/trap rule); evaluation order of
  arguments; the doc-comment syntax `nomen docs` consumes; how `nomen test`
  files are written (assertions); program entry (`pub func main`) and exit
  codes; global variables (mentioned in passing at `:4160` but never
  specified).
- **Missing from the operator precedence table** (`SPEC.md:2571-2586`): `??`,
  `!!`, postfix `!`, `?.`, `as`, `..`, unary `-`.
- `SPEC.md:2607` lists the overloadable operators, but `#op_as` (`:2765`) is
  missing from the list.
- The SPEC reads as a changelog in places: long single-paragraph rule dumps
  such as `:158`, `:197`, `:2079-2085` and `:4253-4265`. Splitting each into a
  short rule, an example, and an edge-case list would make it much easier to
  read on the site.

---

## 2. Language design consistency

### 2.1 Constraints: three different models (P0)

1. Docs: "only checked when the value is a compile-time constant".
2. `.at()` and `/`: a runtime value must be **proven**, or it's an error
   (`cannot be verified`).
3. User parameter constraints: behave like (2), as verified.

Since (2) and (3) are the real behaviour, constraints are refinement types
checked by flow facts. That's a strong feature, but only if the flow analysis
is good enough. Today it isn't:

- **No facts after an early return.** After `if n == 0 { return 0 }`,
  `divide(a, n)` still fails (verified, and logged in FOLLOWUP).
- **`.length` is a signed `int`.** `if n < arr.length { arr.at(n) }` fails
  because `n >= 0` isn't known, even when `n` is itself a `.length`
  (verified). Make lengths non-negative facts, or make them `uint`.
- **No way to assert a fact**: there is no `assume`/`assert` or checked
  narrowing such as `arr.at_checked(i) -> T?`. The `_or_panic` family is
  mentioned (`SPEC.md:2750`) but not documented.

Recommendation: document the "must prove" rule as the language contract,
give the provable fact set (guards, loop ranges, early returns, length ≥ 0),
and add an escape hatch, such as `arr.get(i)` returning `T?` and an explicit
`assert(cond)` that both checks at runtime and adds the fact.

### 2.2 Methods: `self` spelling and static methods (P1)

- A method with no `self` is static (`Task.current_cancelled`,
  `SPEC.md:4551`). But trait methods written without `self`
  (`Stringable.to_string = (out string)`) are called on instances, and they
  compile. So whether a method is static depends on context.
- `self` is read-only, `ref self` is mutable, and `#init` takes either (and
  writes to it in both cases). `#destroy` takes nothing but uses `self`.
- There's no `static` keyword and no `Self` documentation, yet
  `SPEC.md:1034` uses `#self other, out Self`, which compiles but is
  explained nowhere outside comptime.

Recommendation: always require `self` for instance methods. Mark static
methods explicitly (`static func`, or `Type.func`). Document `Self` and the
`#self` placeholder in the Traits section.

### 2.3 Copyable vs. `mv`, and destructors (P0 design)

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

### 2.4 Results, errors and nullables (P1)

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

### 2.5 Two spellings for one thing (P2)

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

### 2.6 Statement and expression forms (P2)

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

### 2.7 Types (P2)

- `ufloat` family: unsigned floats are unusual, and their semantics
  (negative results from subtraction? NaN?) aren't specified.
- Implicit widening rules are stated twice with slightly different wording
  (`SPEC.md:2776-2779` and `:3142-3146`).
- `Channel` is untyped (`uint64` values plus `send_string`) because "Nomen
  values are pointer-sized" (`SPEC.md:4071`). That's out of step with the rest
  of a statically typed language. See §3.
- Struct layout puts an 8-byte vtable word in **every** struct
  (`SPEC.md:3727`), so `Pair { int64, int32 }` is 24 bytes and
  `offset_of(Pair, "b") == 16`. This is a performance and FFI design choice
  worth stating explicitly (and possibly reconsidering for structs with no
  trait conformance).

### 2.8 Lint false positives found while verifying (P2)

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

## 3. Missing features (vs Rust, Swift, Zig, Go, Kotlin)

Ordered by rough priority within each tier. "Effort" is a guess.

### Tier 1: high priority (blocks idiomatic code today)

| Feature                                                                                                                       | Peers                                                                   | Rationale                                                                                                                         | Effort |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Flow-sensitive constraint facts (early return, `else`-after-guard, `len >= 0`, facts from `while` conditions)                 | Rust (NLL-style flow), Kotlin smart casts, Swift `guard`                | Constraints are enforced for runtime values, so without this ordinary guard code fails. This is the single biggest friction point | M      |
| `guard`/early-exit narrowing for nullables and results (`const v = x ?? return`, or `guard let`)                              | Swift `guard`, Kotlin `?: return`, Rust `let … else`                    | Pairs with the item above. Today the narrowing only flows into the `if` body                                                      | S–M    |
| Match guards, or-patterns, nested/struct patterns, range patterns (`case .rect(w, h) if w == h`, `case .a, .b`, `case 1..10`) | Rust, Swift, Kotlin `when`                                              | `match` is central, but currently it handles only one level of case + bind. That's why composed errors need three nested matches  | M      |
| Typed `Channel<T>`                                                                                                            | Go, Rust mpsc, Kotlin channels                                          | The untyped `uint64` channel plus `send_string` doesn't fit a typed language with `Sendable`                                      | M      |
| Generic methods (`func map<U> = (self, func (T, out U) f, out List<U>)`)                                                      | All peers                                                               | `SPEC.md:3860`: "there are no generic methods". This blocks `map`/`filter`/`fold` on collections                                  | M–L    |
| Comparison and ordering overloading (`#op_lt` / a `Comparable` trait), unary `-`, index operators                             | Rust `PartialOrd`/`Index`, Swift `Comparable`, Kotlin `compareTo`/`get` | Only arithmetic and `==` are overloadable. Sorting user types and generic `max`/`min` need ordering                               | S–M    |
| `[]` index sugar for `.at`/`.set`                                                                                             | All peers                                                               | `arr.at(i)` and `grid.at(1).at(0)` are verbose. `p[i]` already exists inside `unsafe`, so the syntax is free                      | S      |

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

## 4. Suggested order of work

1. Fix the five README failures and the `SPEC.md` P0 rows in §1.2. Then
   regenerate `test/readme/` and `test/spec/` from the docs so they can't
   drift again (§1.1).
2. Rewrite "How Constraints Are Evaluated" to describe the real rule, and in
   the same change land flow facts for early return and `length >= 0` (§2.1).
3. Purge retired `class` and the stale "Stage" paragraphs. Fix the two broken
   links and the duplicate headings (§1.3–1.4).
4. Make `#destroy` imply `mv` (§2.3). This is a soundness fix, not just docs.
5. Decide the method receiver and static-method rule (§2.2), and the
   result-`match` flattening question (§2.4). Both affect many examples, so
   settle them before more docs are written.
6. Work through the Tier 1 features in §3.
