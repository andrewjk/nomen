# Comptime: Pragmas and Compile-Time Reflection

Design notes for `#`-directed compile-time controls (`#if`, `#for`) and a
`META` namespace exposing compiler/type information. Working document —
nothing here is implemented yet.

```
#if META.arch == "c" { ... }
#for field of META.info(T).fields { ... }
```

## Why this fits Nomen already

The language has quietly prepared the ground:

- **`#` is already the directive namespace.** `#arch: c` / `#arch: aarch64` /
  `#arch: aarch64_use_c` establish `#` as "the compiler is being spoken to."
  `#if` / `#for` extend that family rather than inventing syntax.
- **The checker already constant-folds conditions.** `if` conditions with
  compile-time-known values are evaluated and dead branches dropped
  (`src/check/check_if_else_node.ts`), including inside generic bodies where
  neither arm type-checks generically.
- **Monomorphization already substitutes comptime constants.** `T_SIZE`,
  `T_NEEDS_STRDUP`, `T_FAT` are per-instantiation constants spliced into
  generic bodies (SPEC, inline code blocks). That is ad-hoc comptime;
  `META.info(T)` is its generalization.
- **Auto-derived methods are hardcoded derives.** `Stringable`, `Equatable`,
  and `Hashable` conformance synthesizes methods by recursing over fields
  (SPEC, Auto-Derived Methods). A JSON decoder is "user-land derive." A good
  long-term target: express those derives themselves via
  `#for field of META.info(T).fields`.

So `#if META.arch == "c"` is less a new feature than a formalization of
mechanisms that already exist informally.

## Pragma vs. reflection: same thing?

Same mechanism — code running inside the compiler with access to compiler
state — but different consumers and different phases:

- **Pragmas** configure the compilation of surrounding code
  (`#if META.arch` selects a body).
- **Reflection** drives codegen over type structure
  (`#for field of META.info(T).fields`).

Precedents split on this: Zig unifies everything into comptime; Odin
deliberately separates `when` from type-info-in-polymorphic-params; C keeps
the preprocessor separate from `constexpr`/reflection.

Suggested stance: one `META` namespace, but stage the _evaluator_:

1. `#if META.arch` needs only constant-expression evaluation — which the
   checker already does.
2. `#for`-over-fields needs type info plus unrolling — effectively a second
   monomorphization dimension.

Ship `#if` first. Note the phase dependency: `#if META.arch` can fold at
parse time, but `#if META.info(T).fields.length > 0` requires `T` to be
checked first. A rule is needed for what `META.info` reports about
forward-referenced types (Zig pays for this with "unable to resolve comptime
value").

## The hard parts (what other comptimes do that we must not skip)

### 1. The field-name binding problem — the linchpin

Inside `#for field of META.info(T).fields`, how does the body touch the
field? Zig answers with `@field(obj, field.name)`: field access by a
_comptime string_, plus comptime string comparison and formatting. Without
an equivalent, iterating fields is decorative. Design this first.

### 2. Bodies vs. declarations

`#for` inside a function body (unrolled, like the existing monomorphizer)
covers decoders:

```
func JSON.decode_T(s: string) -> ... {
    #for field of META.info(T).fields { ... }
}
```

Viewmodels and DB proxies eventually want to generate _declarations_ —
Zig's `@Type`, D template mixins, Jai's `#insert`. That is a much bigger
step (naming, caching, hygiene); fine to defer. But decide now that
`#if` / `#for` are valid at declaration scope, not just in bodies —
selecting whole funcs/structs is the easiest, highest-value form (it is
just filtering root children).

### 3. Attributes

serde-style use cases need `#[rename: "..."]`, `#[skip]`, defaults —
per-field metadata that `META.info(T).fields[i]` exposes. Retrofitting an
attribute syntax is painful (it touches struct parsing everywhere), so
design even a minimal one up front. Precedents: D UDAs, Rust `#[...]`,
Jai member annotations.

### 4. Generics composition

The real payoff is one generic decoder rather than one written per struct:

```
func JSON.decode(T: type, s: string) -> Result(T)
```

Nomen generics are already monomorphized with type params in scope, so
`META.info(T)` inside a generic body is where this becomes powerful.
Comptime over concrete types only is still useful (generalized derives)
but captures half the win.

### 5. Diagnostics

Errors inside unrolled code need two locations: the generated site _and_
the `#for` that spawned it. `CompileError` carries `start`/`line`/`column`;
generated nodes should also carry their spawn point. Design this before
error messages become archaeology.

## What other comptimes do that we can skip (for now)

- **Full-language comptime interpretation** (Zig): running arbitrary user
  functions at compile time — compile-time regex compilation, hash tables.
  Expensive: the compiler becomes an interpreter of itself. A restricted
  pure-expression grammar for conditions avoids this.
- **AST macros** (Rust proc macros, Nim): syntax-level transforms with
  hygiene problems. The stated use cases do not need them.

## What we will want cheaply

- `META.size_of(T)` / `offset_of` / alignment introspection — the aarch64
  backend needs this information anyway.
- `#if` selecting between `#arch:` variants — a nice internal first
  customer for `META.arch`.
- Comptime string literals and formatting for generating names
  (`"decode_" + T.name` style).

## Suggested staging

1. `META.arch`-style `#if` at declaration and body scope.
2. `META.info(T)` + `#for` with comptime-string field access
   (`@field`-style).
3. Attributes, exposed via `META.info(T).fields[i].attrs`.
4. Generic `T: type` parameters composing with reflection.
5. (Someday) declaration/type generation.
