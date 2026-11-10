# The JavaScript Backend

`src/build_js` compiles the **checked Nomen AST** to a self-contained ES module
(`main.mjs`) that Node runs directly:

```bash
nomen run --arch js            # writes build/main.mjs and runs it with node
nomen build --arch js          # writes build/main.mjs only
```

Because the input is the checked AST, borrow/move rules, constraints,
format specs, overload resolution, generic specialization, devirtualization,
and `checked`-enum/ bitset discard rules are all enforced by the normal
compiler before the JS backend runs. The backend never re-checks types; it
maps the resulting program onto JavaScript.

## Value mapping

| Nomen                     | JavaScript                                                 |
| ------------------------- | ---------------------------------------------------------- |
| every `int`/`uint` family | `bigint`                                                   |
| every `float` family      | `number`                                                   |
| `string`, `char`          | `string` (a char is one JS character)                      |
| `bool`                    | `boolean`                                                  |
| `T[]` / `Array<T>`        | JS array                                                   |
| `List<T>`                 | JS array                                                   |
| `Set<T>`                  | JS `Set`                                                   |
| `Map<K, V>`               | JS `Map` (keys by JS identity — see below)                 |
| `StringBuilder`           | `{ s }`                                                    |
| `Box<T>`                  | `{ __value }` (access through the box is transparent)      |
| struct                    | plain object with a `$type` method table                   |
| enum                      | `{ $tag, <payload fields> }`                               |
| tuple                     | `_Tuple_…_init` object with `_0`, `_1`, … fields           |
| trait-typed value         | the concrete struct value; trait calls dispatch on `$type` |

Strings and chars are JS strings rather than UTF-8 byte buffers; UTF-16 code
units and UTF-8 bytes differ for non-ASCII text (see FOLLOWUP.md).
Integers are `bigint` and do not wrap at 64 bits.

## Ownership

Ownership, `mv` transfers, auto-free, `#destroy`, `view` borrows, and the audit
runtime are native-memory concerns with no JavaScript analogue — the engine's
GC owns values. `ref` parameters and `for ref` element write-back ARE modelled:
`ref` arguments are boxed at the call site (`{ v }`), the callee writes through
the box, and the caller copies the box back, so the callee's mutations are
observable. Non-`mv` value structs are copied on binding, assignment, return,
container store, and closure capture, matching Nomen's value semantics.

## Control flow and expressions

`if`, `switch`, and `match` work as statements and as expressions (the
expression forms lower to an IIFE). `while cond; update`, `break`, `continue`,
`for x of xs`, `for ref x of xs`, and `for i of a .. b` all lower directly.
`match` on enums compares `$tag` and binds payloads positionally.

## Library support

`Console`, `Format` (including custom `#,##0.00` patterns), interpolation, the
string/array builtins, `List`/`Set`/`Map`/`StringBuilder`/`Box`, `Option`/
`Result`, `Math`, `Random` (seeded), `Time`, `int.parse`, `Array.with`, and
`Text.Regex`/`Json`/`Chars`/`Utf8` are available.

System-library code that is written in plain Nomen is **lowered on demand**
(`src/build_js/library_queue.ts`): the backend emits the checked body of the
method the program actually calls, and the queue drains transitively. A
library body that needs raw memory (`#arch`, `unsafe`, pointer indexing,
`foreign` calls) becomes a loud `__unsupported` stub instead of silently wrong
code. Natively modelled types (`List`, `Map`, `Set`, `Box`, `StringBuilder`,
`String`, the primitive wrappers, `Array`, `Console`, `Format`) are never
lowered generically.

## Known gaps

Anything requiring JavaScript-incomprehensible machinery fails loudly at
runtime with `js backend: unsupported feature: …` rather than producing wrong
output:

- concurrency (`spawn`, `async`, `Thread`, `Fiber`, `Channel`, `Mutex`,
  `Atomic`, `Nursery`, `Task`) — the emitted program is synchronous;
- raw memory (`unsafe`, pointer types, pointer indexing, `foreign func`,
  `#arch` blocks, `Buffer` internals);
- GUI controls (`System::Controls`) — native AppKit only.

`Random()` seeds from `Date.now() * 1_000_000` (millisecond precision).
Struct-valued `Map` keys compare by JS identity, so a value-hashed lookup
behaves differently from the native backends; use `Map<string, T>` or the key's
own `to_string()` as the key.
