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

| Nomen                          | JavaScript                                                 |
| ------------------------------ | ---------------------------------------------------------- |
| every `int`/`uint` family      | `bigint`                                                   |
| every `float` family           | `number`                                                   |
| `string`, `char`               | `string` (a char is one JS character)                      |
| `bool`                         | `boolean`                                                  |
| `T[]` / `Array<T>`             | JS array                                                   |
| `List<T>`                      | JS array                                                   |
| `StableList<T>`                | JS array (stable indices are plain element references)     |
| `Buffer<T>` / `ClassBuffer<T>` | JS array (capacity is the array length)                    |
| `Set<T>`                       | JS `Set`                                                   |
| `Map<K, V>`                    | JS `Map` (keys by JS identity — see below)                 |
| `StringBuilder`                | `{ s }`                                                    |
| `Box<T>`                       | `{ __value }` (access through the box is transparent)      |
| struct                         | plain object with a `$type` method table                   |
| enum                           | `{ $tag, <payload fields> }`                               |
| tuple                          | `_Tuple_…_init` object with `_0`, `_1`, … fields           |
| trait-typed value              | the concrete struct value; trait calls dispatch on `$type` |

Strings and chars are JS strings rather than UTF-8 byte buffers; UTF-16 code
units and UTF-8 bytes differ for non-ASCII text (see FOLLOWUP.md).
Integers are `bigint` and wrap at their storage width (64 bits for `int`/`uint`,
the declared width for sized types).

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
`Result`, `Math`, `Random` (seeded), `Time`, `int.parse`, `Array.with`,
`Text.Regex`/`Json`/`Chars`/`Utf8`, and the slot-buffer containers built on
`Buffer`: `LinkedList`, `Graph`, `Tree`, `Arena`, `StableList`, `JsonTree`
(`Text.Json.parse`/`stringify`), and `BigInt`.

System-library code that is written in plain Nomen is **lowered on demand**
(`src/build_js/library_queue.ts`): the backend emits the checked body of the
method the program actually calls, and the queue drains transitively. A
library body that needs raw memory (`#arch`, `unsafe`, pointer indexing,
`foreign` calls) becomes a **warning stub**: it writes
`js backend: skipping unavailable feature: …` to stderr once and returns a
zero value for its declared return type, so the rest of the program keeps
running. Natively modelled types (`List`, `StableList`, `Buffer`, `Map`, `Set`,
`Box`, `StringBuilder`, `BigInt`, `String`, the primitive wrappers, `Array`,
`Console`, `Format`) are never lowered generically.

`Buffer<T>` and `ClassBuffer<T>` map onto JS arrays, so `.cap` reads return the
array length and `alloc`/`grow`/`load`/`store`/`replace`/`move`/`shift`/
`slice`/`copy` are array operations. This is what lets the containers above
(plus `BigInt`) cross-compile and run without the native slab. `slice` yields a
copy (a JS array), not a borrowed `view`; the raw slab protocols (`init_view`,
`store_in_slab`, …) are only reachable from raw library bodies and take the
warning-stub path.

### Concurrency runs synchronously

There is no scheduler or thread pool. `async { ... }` executes its body inline,
`Thread(...)` / `Fiber(...)` constructions record a thunk, and `.start()` runs
that thunk to completion before returning a finished `Task` (`.detach()` runs
it and discards the handle). `Task.wait` is a no-op, `result` /`result_uint64` /
`is_done` read the completed result (a second `result` yields the zero value,
matching the native move-out), and `cancel`/`current_cancelled` are inert.

`Channel` is an in-memory FIFO (`receive` yields the zero value when empty
instead of blocking), `Mutex.lock`/`unlock` are no-ops, and `Atomic` operations
are plain reads/writes. A nursery's implicit join is already satisfied, so
`timeout` and `mode: "race"` have no effect. `Thread`/`Fiber`/`Task` still
satisfy `Spawnable`/`Awaitable` through their synthesized `$type` tables.

## Known gaps

Constructs that cannot be expressed at all are still rejected by the checker
(user `unsafe`, pointer types, `foreign func`). Everything else in the library
degrades instead of aborting: a raw library body warns once and the program
continues.

- `#arch` blocks and `foreign func` bodies reached through library code are
  skipped with a warning (e.g. the audit counter used by `Tester`).
- GUI controls (`System::Controls`) are native AppKit calls, so their methods
  are skipped; the site's embedded library excludes them entirely.
- Concurrency runs synchronously (see above): `.detach()` executes the task
  immediately, so a process-lifetime daemon loop never returns; the playground's
  5-second watchdog stops such a program.

`Random()` seeds from `Date.now() * 1_000_000` (millisecond precision).
Struct-valued `Map` keys compare by JS identity, so a value-hashed lookup
behaves differently from the native backends; use `Map<string, T>` or the key's
own `to_string()` as the key.
