# Comptime Compared: Zig, Rust, Swift, C#

How Nomen's compile-time features ([`COMPTIME.md`](./COMPTIME.md)) compare
to the four systems people usually mean when they say "comptime" or
"macros". The honest summary: Nomen is **"Zig-lite for reflection and
generation"** — it covers the highest-volume real-world macro uses
(derives, per-field/per-case generation, attribute registries, per-size
type families) with no build step or plugin toolchain, but it has no user
comptime evaluator and no syntax-transformation surface.

## Where Each System Sits

| System             | Model                                                                                                       | Strongest at                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Zig** `comptime` | Full language evaluation at compile time; `@Type` constructs types                                          | Types from computed data; algorithmic tables; C-header translation          |
| **Rust**           | `macro_rules!` (token patterns) + proc macros (Rust code over tokens) + `const fn`/const generics           | Ecosystem derives (serde, clap), build-time IO/verification, DSLs           |
| **Swift**          | Macros as compiler plugins over syntax trees; result builders                                               | Peer/accessor member generation, DSLs (`@ViewBuilder`), `@Observable`       |
| **C#**             | Roslyn source generators (a compiler plugin with full semantic model); runtime reflection; expression trees | Project-wide code generation (`[ObservableProperty]`, JSON), runtime DI/ORM |
| **Nomen**          | `#` pragmas + `META`; expansion during check                                                                | Reflection-driven derives and generation, all in-language, no toolchain     |

Worth keeping even-handed: Swift has **no comptime evaluation** of
arbitrary code and no const generics (its macros are syntax transforms);
C# has **no in-language codegen** (generators are compiler plugins) but
full **runtime** reflection, which Nomen deliberately lacks; Rust's type
construction needs proc macros even though `const fn`/const generics run
at compile time; Zig has no macros at all.

## What They Can Do That Nomen Can't (with real-world uses)

### 1. Comptime evaluation — arbitrary compile-time code

- **Zig:** comptime functions that return **types**
  (`fn Matrix(comptime rows: usize, comptime cols: usize) type`),
  `@Type` building a struct from computed data, comptime params of any
  kind (ints, enums, structs, functions), `@sizeOf`/`@alignOf`/
  `@offsetOf`. Real-world: N-dimensional vector/matrix libraries,
  capacity-parametrized buffers, ECS archetypes, `@cImport` translating C
  headers into Zig types, and **algorithmic lookup tables** (CRC32, AES
  S-boxes, sin tables) computed by real code at compile time.
- **Rust:** `const fn` evaluation and const generics (`[T; N]`) for SIMD
  widths, fixed matrices, hash capacities.
- **Nomen status:** per-size **type families** work
  (`#for n of 4..6 { pub mv struct buffer_#{n}<T> { ... } }`) and
  per-index constants fold arithmetically (`#i * #i + 1` → literal). But
  there are no comptime _function calls_, so no algorithmic tables; no
  comptime params beyond `type T`, so a family must be generated rather
  than parameterized; and no sizes/offsets in reflection.

### 2. Compile-time IO and semantic-model analysis

- **Rust** (`proc macros` + `build.rs`): `sqlx::query!` verifying SQL
  against a live database at build; protobuf/gRPC codegen from `.proto`;
  `bindgen` from C headers; `include_str!`/`include_bytes!`; env vars and
  config at build time.
- **C#** (Roslyn generators): `System.Text.Json` serializers,
  `[LoggerMessage]` fast logging, regex→DFA codegen, `[ObservableProperty]`,
  project-wide symbol graphs.
- **Nomen status:** `#embed_file` only (≈ `include_str!`). No database,
  IDL, env access or code analysis — `META` exposes arch/platform only.
  This class needs a build step or a compiler plugin API, which is a
  deliberate non-goal today.

### 3. Augmenting existing types (the "partial member" shape)

- **C#:** `[ObservableProperty]` turns a field into a property with change
  notification on the _same_ type; source generators add serialization
  members to your class.
- **Rust:** proc macros emitting `impl Display for T`, `impl From`, trait
  impls for foreign traits.
- **Nomen status:** the primary practical gap. A file-scope arm generates
  _new_ declarations, but `extend struct #{t.name} { ... }` fails to parse
  (`parse_extend`'s target-name position does not accept a splice). Trait
  _defaults_ do attach generated method bodies to conforming types; peer
  members on a hand-written type do not. Recorded in FOLLOWUP; a small
  parser fix (the same intercept `parse_struct` uses).

### 4. Arbitrary syntax transformation and DSLs

- **Rust** `macro_rules!` (token patterns, variadic `$(...)`),
  `#[tokio::main]` rewriting a function body, `lazy_static!`,
  state-machine DSLs; `serde`'s rich attribute grammar
  (`#[serde(rename = "...", skip_serializing_if = "...")]`).
- **Swift** `@Observable` interposing storage, property wrappers
  (`@Argument`, `@Published`), result builders (`@ViewBuilder` — a
  statement-sequence DSL), custom diagnostics with spans and fix-its.
- **Nomen status:** generation is **reflection-shaped** — templates over
  reflected fields/cases/types with a fixed binding grammar. No token or
  AST pattern matching, no source-text access, no body rewriting, no DSL
  grammars. Attribute arguments are single comptime literals consumed by
  name (`.attr("x")` returns the first value), so serde/clap-style
  configuration needs a structured-attribute design first.

### 5. Trait-conformer iteration

- Real-world: "apply this to every type implementing `Plugin`/`Entity`" —
  DI registration, serializer registries, test matrices.
- **Nomen status:** `META.types_with("attr")` covers the _attribute_
  registry — the common Roslyn/`System.Text.Json` shape. Enumerating a
  trait's **conformers** is recorded as the deepest remaining iterable:
  the set is open-ended (a conformance later in the file or in another
  module must participate), while every current iterable is closed at
  expansion time.

### 6. Runtime reflection / expression trees (C#)

- Real-world: EF Core translating lambdas to SQL, DI containers resolving
  by runtime type, plugin loading, `Moq` proxies, config binding.
- **Nomen status:** compile-time-only by design — no runtime type
  metadata. That is a **philosophy trade** (no reflection cost, no
  vtable-heavy containers unless asked) rather than a missing feature: a
  program that needs "ask the type at runtime" is not this tool.

## Where Nomen Is Ahead or Equal

- **Derives are language features, not proc-macro crates.** `Stringable`/
  `Equatable`/`Hashable` are library `#for` defaults with
  `@hash_ignore`-style configuration — no separate crate, no `syn`
  dependency, no macro/toolchain version skew. Any user trait with a
  reflection default gets the same treatment.
- **Generated code gets the full checker.** Ownership, last-use,
  strdup/free analysis and bounds contracts all run on it. Proc-macro
  output is often opaque to such analyses; C# generators produce code the
  compiler must trust.
- **One coherent binding model** — member bare (`field.name`), whole value
  `#t`/`#i`/`#word`, identifier splice `#{...}` — with loud errors, across
  every declaration kind (structs, traits, enums, files) and both native
  backends plus JS from one source.
- **Per-size generic families** are expressible today (`buffer_4`,
  `buffer_5`), covering much of what const generics are used for, without
  a parameterized family.
- **Unified target selection:** `#if META.arch` gates ordinary code and
  raw bodies alike.

## Ranked Gaps (leverage vs cost)

1. **`extend` target splices** — peer members on existing types; small
   fix, unlocks framework-style code (ORMs, MVVM, registries).
2. **Trait-conformer iteration** — DI/serializer registries by contract
   instead of attribute.
3. **Structured attributes** (named arguments, lists) —
   serde/clap-grade configuration and diagnostics.
4. **Comptime evaluation** (const-fn-like helpers callable from arms,
   sizes/offsets) — algorithmic tables, layout-sensitive code.
5. **Compile-time IO / semantic analysis** — the sqlx/protobuf class;
   decide explicitly whether it is in scope at all.

Deliberately declined: arbitrary syntax/AST transformation (a different,
much larger design with hygiene risk) and runtime reflection (contrary to
the memory and performance model).

## See Also

- [`COMPTIME.md`](./COMPTIME.md) — how comptime works today.
- [`../FOLLOWUP.md`](../FOLLOWUP.md) — recorded comptime residuals.
