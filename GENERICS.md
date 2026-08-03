# Generics

Nomen has three kinds of generics — generic **structs** (`struct List<T>`),
generic **traits** (`trait Viewable<T>`), and generic **free functions**
(`func unwrap<T>`) — all resolved at compile time. There are no virtual
generic calls and no runtime type reification.

This document describes how generics are implemented. For the user-facing
surface, see the "Generics" section of [README.md](README.md) and the
"Generic Structs" section of [SPEC.md](SPEC.md); for the storage model that
underpins type erasure, see the "Generic Containers" section of
[MEMORY.md](MEMORY.md).

## Strategy

Generics are implemented as **compile-time monomorphization with type-erased
storage**:

- **Type erasure.** On aarch64 every value — `int`, pointer, class reference,
  enum, struct by value — occupies 8 bytes (see [MEMORY.md](MEMORY.md)).
  Inside a generic body, `T` is therefore a compile-time concept only: every
  `T` slot is 8 bytes, and the generated code never specializes layout. The
  core containers exploit this directly — `List<T>` stores items via
  `Buffer.store_int` / `Buffer.load_int`, so a single `List.push` body serves
  every `T`.
- **Monomorphization for distinct symbols.** What _does_ require specialization
  is producing distinct C / asm symbols. Each instantiation of a generic
  struct spawns a mangled clone (`List<int>` → `List_int`) that owns its own
  `_init` / methods. This is necessary, not optional: the C linker needs one
  symbol per layout, and field/method codegen needs to resolve `T` to a
  concrete name. Memoization ensures each distinct instantiation is emitted
  exactly once.
- **No layout / dispatch specialization.** The mangled clone shares the
  generic body verbatim (with `T` textually substituted); it is not
  re-optimized per `T`. Vtable dispatch on a generic trait is keyed by the
  trait _name_, so type arguments don't affect vtable layout — a generic
  trait dispatches exactly like its non-generic counterpart.

The result is a single, simple model: the check phase synthesizes concrete
clones into the AST, and the build phase treats them as ordinary structs and
functions. Neither backend has a "generics" code path.

## Declaration sites

Type parameters are declared in angle brackets after the name. Only struct
type parameters may carry trait bounds.

```nomen
struct List<T> { ... }              // generic struct
struct Map<K, V: Hashable> { ... }  // two params, one bounded
trait Viewable<T> { ... }           // generic trait (no bounds allowed)
func unwrap<T> = (Box<T> box, out T) { ... }   // generic free function
```

Parsing is split across `src/parse/`:

| Construct              | Parser                        | Notes                                                                                    |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| Struct `<T: Bound>`    | `src/parse/parse_struct.ts`   | `:` then `+`-separated trait names. `type_params` and `type_param_bounds` stay parallel. |
| Struct `: Trait<Args>` | `src/parse/parse_struct.ts`   | Conformance args parsed into the parallel `trait_args` array.                            |
| Trait `<T>`            | `src/parse/parse_trait.ts`    | No bounds supported on trait type params.                                                |
| Function `<T>`         | `src/parse/parse_function.ts` | No bounds supported on function type params.                                             |
| Type-args at use sites | `src/parse/parse_type.ts`     | `List<int>`, `Map<string, int>`. `Array<T>` is rewritten to the internal array form.     |

### The `>>` tokenizer problem

The tokenizer greedily matches `>>` and `>>>` as shift operators, so nested
generics like `Greetable<Wrap<int>>` lex as a single `>>`. The shared helper
`src/parse/utils/expect_close_angle.ts` peels one angle off a `>>`/`>>>` token
in place — leaving the remaining `>` behind for the next close. It is only
called at known generic-close positions, so genuine shift operators are
unaffected.

### Generic arguments in expression context

In declarations, `<` unambiguously opens a type-argument list. In expression
context, `<` is also the comparison operator. `try_parse_generic_args` in
`src/parse/parse_expression.ts` resolves the ambiguity by **speculative
parsing with full state rollback**: it saves the token index, values, and
error count, attempts to parse `<Type, ...>`, and on any failure (or if the
closing `>` isn't immediately followed by `(` or `.`) rewinds and treats `<`
as comparison. A successful parse requires a follow token of `(` (constructor
call) or `.` (static method on a generic type), which is what distinguishes
`Box<int>(42)` from `a < b`.

## Type checking

`CheckStatus.type_params: string[]` is the scope stack of currently-unbound
type-parameter names. `check_struct_node` and `check_trait_node` push the
declared params while checking the body and pop them on exit, so references
to `T` inside a generic body resolve as ordinary types.

```typescript
// src/check/CheckStatus.ts
type_params: string[]   // e.g. ["T"] while inside `struct List<T>`
```

### Bare generic references

A generic type used without arguments is rejected unless every one of its
type parameters is in scope (`check_type_exists` in
`src/check/utils/check_type_exists.ts`). This is what allows a generic body
to self-reference (`var Box other` inside `struct Box<T>` is fine) while
rejecting `var Box b` at a call site where `T` is unbound.

### Trait bounds

For `struct Container<T: Control>`:

- **At declaration** (`check_struct_node`): each named bound must be a known
  trait. The conformance of the eventual type _argument_ isn't checked here —
  it can't be, the arg isn't known yet.
- **At monomorphization** (`monomorphize` in
  `src/check/check_function_call_node.ts`): each concrete type arg is looked
  up among known structs and required to include every bound in its `traits`
  list. Primitives and non-conforming structs are rejected at the call site.

### Generic free-function bodies are deferred

`check_function_node` registers a generic function (`is_generic = true`) but
does **not** check its body — the body is checked once per specialization,
after `T` is bound to a concrete name. A generic function is therefore never
emitted on its own; only its specializations are.

## Monomorphization

`monomorphize` in `src/check/check_function_call_node.ts` is the central
instantiation routine. It runs whenever a generic struct meets concrete type
arguments — a constructor call (`List<int>()`), a typed declaration
(`var List<int> x`), a field whose type is a generic instantiation, a method
call on a generic receiver, `spawn` (which instantiates `Task<T>`), or the
array method dispatcher.

The steps, for `List<int>`:

1. **Arity check.** Wrong number of type args is a hard error.
2. **Defer if any arg is still a type parameter.** If we're checking a field
   like `Buffer<T> items` _inside_ `struct List<T>`, `T` is unresolved, so no
   phantom `Buffer_T` is created. The enclosing generic will be monomorphized
   later, and at that point the substitution rewrites the field type to
   `Buffer_int`, which triggers its own monomorphization.
3. **Mangle a name and memoize.** `List<int>` → `List_int`;
   `Map<string, int>` → `Map_string_int`; `Buffer<List<int>>` →
   `Buffer_List_int` (the inner arg is already mangled by the time it arrives).
   If a struct with that name already exists, return it.
4. **Enforce trait bounds** against the concrete type args (see above).
5. **Build a substitution map** `{ T → "int", ... }`.
6. **Clone fields and methods**, applying `substitute_type` to every `Type`
   field and `substitute_body_types` to walk every statement and rewrite
   types throughout the bodies. Local labels are renamed to the mono name to
   avoid collisions. Field default values get the same substitution via
   `substitute_raw_in_node` (which also rewrites identifiers inside `#arch`
   raw blocks — see below).
7. **Resolve `Buffer<Elem>` fields.** A field of type `Buffer<T>` is
   re-routed to `Buffer<Elem>` or `ClassBuffer<Elem>` depending on whether
   the resolved element is a class/trait or a plain value, then
   monomorphized in turn.
8. **Re-check custom `#init`.** Variadic-tuple constructors (e.g.
   `Map<K,V>(["a",1], ["b",2])`) get a fresh `#init` clone, re-checked in a
   scratch status so tuple types materialize and method calls bind against
   the new mono struct. When type args are omitted, they are inferred from
   the variadic tuple's element types.
9. **Inject into the root.** The mono struct is appended to
   `root.statements`, where the build phase will find it and emit it like
   any hand-written struct. The original generic struct is left in place
   with `is_generic = true` and skipped by the builders.

`substitute_type` recurses into `type_args`, `tuple_types`, and function
parameter/return types, so nested generics and generic function-pointers
substitute correctly.

## Generic free functions

Generic functions take a separate path (`specialize_function` in
`src/check/check_function_call_node.ts`) because their type arguments are
**inferred from the call**, not written explicitly — Nomen has no
`unwrap<int>(box)` syntax.

Inference keys off generic-struct-typed parameters. For
`func unwrap<T> = (Box<T> box, out T)` called as `unwrap(b)` where
`b: Box<int>`:

1. Walk the generic function's params; for each one whose type is a generic
   struct (`Box<T>`), look at the corresponding call argument.
2. The argument's type carries the type args directly (`b` has
   `type_args = [int]`) if it was constructed with explicit args, or
   indirectly via `source_type_args` if it was itself the result of a prior
   monomorphization.
3. Build the substitution map `{ T → "int", Box → "Box_int" }`, eagerly
   monomorphize every generic-struct param type, then clone the function
   under the mangled name `unwrap_Box_int`, substitute types throughout the
   signature and body, and re-check it as an ordinary function.

The specialized function is memoized by name, so calling `unwrap` on two
`Box<int>` values reuses one specialization, while `Box<string>` produces a
second (`unwrap_Box_string`).

## Generic traits

A generic trait `trait Viewable<T>` carries `type_params` like a struct; its
method/field signatures may reference `T` while the trait is being checked.
A conforming struct supplies concrete args:

```nomen
trait Greetable<T> {
    func code = (self, out int)
}

class Users: Greetable<User> { ... }
```

- **Arity validation** (`check_struct_node`): the args in `trait_args[i]`
  must match the count of the trait's `type_params`.
- **Conformance signature matching** (`check_trait_conformance`): the trait
  method's signature is first substituted with the conformance args, then
  compared structurally against the struct's override.
- **Vtable layout is unaffected.** Dispatch is keyed by trait name, so type
  args never enter the vtable. A generic trait dispatches exactly like a
  non-generic one.
- **Default-method synthesis** (`synthesize_generic_trait_defaults`): a
  generic trait's default body references `T`, which is unresolved at the
  trait level, so it can't be shared. Instead, each conforming struct gets
  its own synthesized override: the trait default is cloned, `T` is
  substituted with the conformance arg, `self` is retyped to the struct, and
  the body is rewritten. (Non-generic traits keep the shared default-body
  emission.)

## Raw `#arch` blocks

A generic struct's `#arch: c` / `#arch: aarch64` block is textually
substituted at monomorphization (`substitute_raw_in_node`). Type-parameter
identifiers are rewritten to valid C / asm spellings:

- `T` → the concrete C type (e.g. `long` for `int`)
- `T_SIZE` → the byte size (`8`)
- `T_destroy` → the type's `#destroy` symbol (e.g. `Animal_destroy`)
- `T_NEEDS_STRDUP` → `0` or `1`

This is the mechanism `Buffer<T>` uses to emit correctly-typed inline accessors
per element type without a separate specialization pass (see `core/System/Buffer.nm`).

## Building

The build phase has no generics-specific code. Both backends (C in
`src/build_c/`, AArch64 in `src/build_aarch64/`) skip any node with
`is_generic === true` and emit only the monomorphized clones that the check
phase injected into `root.statements`.

| Backend | Generic struct skip        | Generic function skip        |
| ------- | -------------------------- | ---------------------------- |
| C       | `build_struct_node.ts:17`  | (filtered before dispatch)   |
| AArch64 | `build_struct_node.ts:159` | `build_function_node.ts:145` |

A few spots resolve mangled names at the use site so codegen finds the right
clone:

- **Declarations** (`build_declaration_node.ts`) mangle `var Box<Point> b` to
  `Box_Point` for struct lookup, sizing, and field layout.
- **Method calls** on a generic receiver (`build_access_node.ts`) compute
  `Box_int` from `target_type.type_args` and fall back to searching for any
  specialized struct that defines the method.
- **Companion file** (`utils/c_companion.ts`) lowers a generic struct name to
  `void *` when emitting C prototypes for the aarch64 backend, since the
  concrete clones are what actually get declared.
- **Buffer fast path** (`build_access_node.ts`) matches both the generic name
  (`Buffer`) and any monomorphized name (`Buffer_int`, `Buffer_uint32`, ...)
  so strided loads/stores inline correctly per element type.

## Known gaps

- **No generic methods.** `type_params` exist on structs, free functions, and
  traits — not on struct/class methods. A method can use its enclosing
  struct's type parameters, but cannot declare its own `<T>`. This blocks a
  few ownership patterns (see [GUI.md](GUI.md) for the motivating case).
- **No bounds on trait or function type params.** Only struct type params
  accept `: Bound`. `trait Foo<T: Bar>` and `func f<T: Bar>` are not supported.
- **No explicit type arguments at generic-function call sites.** `T` is
  always inferred from the call arguments; you cannot write `unwrap<int>(b)`.
- **No monomorphization-level layout specialization.** Every `T` slot is
  8 bytes regardless of the concrete type. This is a deliberate consequence
  of the storage model (see [MEMORY.md](MEMORY.md)), not a bug, but it means
  a `List<char>` occupies the same memory as a `List<int>`.

## Implementation files

| File                                          | Purpose                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/parse/parse_struct.ts`                   | Struct `<T: Bound>` and conformance `: Trait<Args>` parsing                                                        |
| `src/parse/parse_trait.ts`                    | Trait `<T>` parsing                                                                                                |
| `src/parse/parse_function.ts`                 | Function `<T>` parsing                                                                                             |
| `src/parse/parse_type.ts`                     | Type-argument syntax at use sites; `Array<T>` rewrite                                                              |
| `src/parse/parse_expression.ts`               | Speculative generic-args parsing in expression context (`try_parse_generic_args`)                                  |
| `src/parse/utils/expect_close_angle.ts`       | Peels `>` off `>>` / `>>>` tokens at generic-close positions                                                       |
| `src/check/CheckStatus.ts`                    | `type_params` scope stack                                                                                          |
| `src/check/check_struct_node.ts`              | Struct type-param scoping, trait-bound declaration checks, conformance arity validation                            |
| `src/check/check_trait_node.ts`               | Trait type-param scoping                                                                                           |
| `src/check/check_function_node.ts`            | Registers generic functions; defers their body check                                                               |
| `src/check/utils/check_type_exists.ts`        | Rejects bare generic references outside their defining scope                                                       |
| `src/check/check_function_call_node.ts`       | `monomorphize`, `specialize_function`, `substitute_type`, `substitute_body_types`, generic-trait default synthesis |
| `src/check/check_access_node.ts`              | Field/method access on generic receivers; array method dispatch                                                    |
| `src/check/check_spawn_node.ts`               | `spawn` infers `T` and instantiates `Task<T>`                                                                      |
| `src/build_c/build_struct_node.ts`            | C backend: skips generic structs                                                                                   |
| `src/build_aarch64/build_struct_node.ts`      | AArch64 backend: skips generic structs and generic-trait default bodies                                            |
| `src/build_aarch64/build_function_node.ts`    | AArch64 backend: skips generic functions                                                                           |
| `src/build_aarch64/build_declaration_node.ts` | Resolves generic-typed declarations to mangled mono names                                                          |
| `src/build_aarch64/build_access_node.ts`      | Method-call name resolution on generic receivers; Buffer inline-access fast path                                   |
| `src/build_aarch64/utils/c_companion.ts`      | Lowers generic struct names to `void *` in the C companion file                                                    |
| `test/generics.test.ts`                       | Generic structs and free functions (parsing, checking, build, errors)                                              |
| `test/trait_bounds.test.ts`                   | Trait bounds on struct type params                                                                                 |
| `test/trait_generic.test.ts`                  | Generic trait conformance, default-method synthesis, nested type args (the `>>` case)                              |
