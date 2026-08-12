# Arrays in Nomen: `Array<T>` vs `T[]`

This document describes how array types are represented and lowered, the
`is_array_heap` design that makes `Array<T>` a deterministic heap struct, and
the machinery that materialises `T[]` values into `Array<T>` params. It is the
canonical home for the design decisions previously scattered across
`FOLLOWUP.md` and the ROADBLOCKS `Array<T>.set` entry.

## Storage at a glance

Arrays and strings share the same **own / borrow** distinction. Arrays
additionally have a **stack** column; strings deliberately don't — the rare
fixed-buffer case is already covered by `char[N]` / `byte[N]` (stack arrays
with byte elements), and a stack string of unknown length has no meaningful
lowering.

| Storage | Array          | String        |
| ------- | -------------- | ------------- |
| Own     | `Array<T>`     | `string`      |
| Borrow  | `view T`       | `view string` |
| Stack   | `T[]` / `T[N]` | —             |

The `Array<T>` vs `view T` distinction is the array analog of `string` vs
`view string` (see MEMORY.md §Strings): own (heap, first-class, freed at
scope exit) versus borrow (a `(ptr, len)` slice, non-owning, non-escaping).
A `String`/`string` heap/stack split — mirroring `Array<T>`/`T[]` — is
deliberately **not** adopted: `string` already plays the `Array<T>` role
(heap-owned), and capital-`String`-for-the-heap-one would invert the
Java/Swift/Dart/Kotlin convention.

## The four array forms

Nomen has four distinct array forms, with different representations:

| Form                      | Parse-time `Type`                                | Runtime lowering                                       | Storage                                                     |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| `Array<T>`                | `{name: T, is_array: true, is_array_heap: true}` | heap `struct Array_<T>*` (length header + inline data) | owned heap buffer                                           |
| `T[]`                     | `{name: T, is_array: true}`                      | `T name[N]` local / `T *` param                        | stack / borrow                                              |
| `T[N]`                    | `{name: T, is_array: true, length: N}`           | `T name[N]`                                            | stack (fixed)                                               |
| `[1, 2, 3]` literal VALUE | `{name: T, is_array: true, length: N}`           | `long x[3] = {…}`                                      | stack (or copied into a heap `Array_<T>` when bound to one) |

`Array<T>` and `T[]` are **not** the same type internally. The
`is_array_heap` flag is **originated at parse time** (in `parse_type.ts`) for
source annotations, and **propagated by the checker** onto synthesized values
(wrap temps for `T[]`→`Array<T>` param materialization, `Array.with(...)`
results) — so the heap-vs-stack distinction is always known to the build, not
recovered at build time by an order-dependent "does the mono `Array_<T>`
struct happen to exist?" gate (the old design).

## Why `Array<T>` is a heap struct and `T[]` stays a stack array

`T[]` is a raw C array value: a local `var int[] x = [1,2,3]` lowers to
`long x[3]` (inline stack storage, zero allocation), and a `T[]` param is a
bare element pointer. That is ideal for hot local code, but it cannot:

1. **Be returned from a function** — C can't return a stack array by value, so
   `func make() -> int[]` needs a backing store.
2. **Be stored in a struct/container** — a `T[]` with a runtime length has no
   fixed layout, so it can't be a field or a `List<Array<T>>` element.
3. **Mutate soundly across a function boundary** — `ref Array<int>` params need
   a struct pointer, not an element pointer.

`Array<T>` lowers to a heap `struct Array_<T>*` — `[length][data…]` — the
minimal representation that makes an array a first-class value: returnable,
storable, ownable, uniformly dispatched (the same reason `List<T>` is
heap-backed).

Keeping them separate matters for performance: `T[]`/`T[N]`/literals stay
zero-allocation stack arrays with compile-time `.length` (used for bounds
discharge and constant folding), while `Array<T>` pays for an allocation only
where escaping/owning semantics are actually needed. A `(ptr, len)` slice —
cheap, non-owning — is already covered by `view T`.

## The `is_array_heap` flag

`parse_type.ts` rewrites `Array<T>` to:

```
{ name: T, is_array: true, is_array_heap: true }
```

`is_array` is kept so the entire array dispatch / bounds / for-of machinery
applies; `is_array_heap` is the deterministic marker that `T[]` and literal
values do not carry.

**Propagation.** The flag is _originated_ by the parser for source annotations,
and _propagated_ by the checker onto synthesized values that must lower like a
heap `Array<T>`:

- wrap temps stamped when a `T[]` value is bound to an `Array<T>` param
  (`check_function_call.ts`, `is_heap_array_literal` / `is_heap_array_copy`),
- `Array.with(elem, count)` results (`check_access_node.ts`).

This keeps the build-time gate (below) purely flag-based — it never needs to
infer heap-ness from the absence of a compile-time `length`.

### Deterministic mono-struct materialisation

Whenever an `Array<T>` annotation appears (param, return, local, field),
`instantiate_generic_type` (in `check_function_call_node.ts`) monomorphizes the
`Array` struct with the element type, so the mono `Array_<T>` struct always
exists by build time. The build never relies on a `.with(...)`/`.at(...)`
elsewhere having instantiated it.

### The build gate

`array_struct_name(type, status)` (`src/build_c/utils/array_struct.ts`) returns
the mono `Array_<elem>` name **iff** the type carries `is_array_heap`. Because
it no longer rejects a length-bearing type, a heap `Array<T>` param/field can
still carry a compile-time `length` (e.g. from a `[ ... ]` initializer) for
`.at(i)` bounds discharge at check time.

## How `Array<T>` lowers

- **Params** → `struct Array_<T>*`, registered in `heap_array_vars` on both
  backends (not `function_array_params` / `function_ref_params`), so
  `.length`/`.at`/`.set`/for-of dispatch through the `Array_<T>` methods. A
  `ref Array<T>` param is a single pointer (mutation is in-place via `.set`,
  no write-back) and is kept out of `function_ref_params`.
- **Locals** → `struct Array_<T>*` (from `Array.with(...)` / a literal or range
  initializer) or a stack `T name[N]` (plain `T[]`/`T[N]`).
- **Returns** → `struct Array_<T>*`.
- **Fields** → `struct Array_<T>*` (not an inline stack array); the struct
  `#init` assigns the pointer, and array methods on the field dispatch through
  the `Array_<T>` helpers (C: `Array_<T>_at(obj.items, i)`, `.length` →
  `obj.items->length`; aarch64: field loads advance to the data pointer).
- **Call sites** forward a heap-array value arg directly (the pointer IS the
  value) — recognised by the flag, not by absence of a compile-time `length`.

### Lengths

- A stack `T[]`/`T[N]`/literal has a compile-time `length`, used by the checker
  for `.at(i)` bounds discharge and by the build for `T name[N]` emission.
- A heap `Array<T>` with a known length (from a literal init) carries it on the
  type for bounds discharge, but the **for-of desugar uses the runtime
  `.length`** for heap arrays — a stamped compile-time length is per-call and
  would be wrong for a different-length argument.
- `Array.with(elem, count)` results carry `is_array_heap` too, so they are
  recognised as heap arrays regardless of the `out.length == count` contract.

## Materialising `T[]` values into `Array<T>` params

`T[]` VALUES (which are stack arrays) are wrapped into a heap `Array_<T>`
buffer when bound to an `Array<T>` param:

1. **Array/range literals** (`sum(Array(2,4,6))`, `sum(1 .. 3)`): the hoisted
   temp is marked `is_heap_array_literal` and built as a heap `Array_<T>`
   buffer (elements from the literal / expanded range). String elements are
   strdup'd on C; `.asciz` addresses stored on aarch64.
2. **Stack-array variables** (`sum(v)` where `v = [2, 4, 6]`): the arg is
   copied into a heap `Array_<T>` temp (`is_heap_array_copy`) — auto-freed, the
   caller's stack array left intact. String elements strdup'd on C; `.asciz`
   pointers copied as-is on aarch64.
3. Excluded from the variable copy (they keep the previous compile-mismatch
   behaviour): `ref Array<T>` params (mutation must propagate to the caller's
   variable, which a copy can't do), class-element arrays, value-struct
   elements.

Both marked temps carry `is_array_heap` on their type, so the build recognises
them deterministically.
