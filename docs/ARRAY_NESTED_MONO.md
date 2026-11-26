# Plan: monomorphize nested arrays on their real element type

Status: steps 1, 3 and 4 started — `first` / `at_end` / `at_or` /
`at_or_null` / `at_or_panic` on nested receivers
dispatch to the row-keyed mono (`ROW_MONO_METHODS` in check_access_node,
row types in `check/utils/array_row_types.ts`). `set` and the static
`Array<Array<T>>.with(row, n)` lower inline (`.set` deep-copies the value
and frees the displaced row; `with` deep-copies the seed into each slot,
`nested_with`), as do `+` / `*` (`nested_op`, each row deep-copied). The
other methods still use the leaf mono and the special paths below.
`slice` takes the row-keyed mono too (`nested_slice`): its result is a
`view` whose `elem` is the row, and `.at(i)` on it reads a borrowed row. Written after the `Array.copy` /
`at_or` nested-row fixes, which each added a special path for nested
arrays.

## The problem

`Array<Array<int>>` is not a generic instantiation in the compiler.
`parse_type` flattens it: the outer `Type` keeps the **innermost** element
as its `name` (`int`) and spells the inner levels on `Type.elem`
(`src/nodes/Type.ts`, `src/parse/parse_type.ts:185`). Method calls then
monomorphize `Array` on `target_type.name`, so `int[]`, `int[][]` and
`int[][][]` all dispatch to the same `Array_int` mono
(`check_access_node.ts`, "route method calls to the Array struct").

That mono's `T` is `int`, so every library method is wrong for a nested
receiver:

- methods returning `T` (`first`, `at_end`, `at_or`, `at_or_panic`,
  `at_or_null`) are typed as the innermost element, not the row;
- methods taking `T` (`set`, `at_or`'s fallback, `with`) expect the
  innermost element;
- raw bodies stride and copy slots at the innermost element's size
  (`T_SIZE`), not the 8-byte row pointer; `copy` was shallow.

Other containers don't have this: `List<List<int>>` monomorphizes as
`List_List_int` (`test/nested_generic_mono.test.ts`), and
`Array<List<int>>` already gets an `Array_List_int` mono whose `first` /
`at_or_panic` are typed correctly. Only array-of-array is flattened.

### Special paths this produced

Each works around the leaf-only mono for a subset of methods:

| Path                    | Where                                                                                           | Covers                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------- |
| `inline_nested_access`  | check_access_node; C/aarch64 build_access_node                                                  | `.at`, `.set`                           |
| `nested_checked_access` | check_access_node; `build_common/nested_checked_access.ts`; both backends                       | `at_or`, `at_or_panic`                  |
| `deep_array_copy`       | check_access_node; `build_c/utils/deep_array_copy.ts`; `build_aarch64/utils/deep_array_copy.ts` | `copy`                                  |
| `is_nested_row_read`    | aarch64 build_access_node                                                                       | base→data pointer for a method on a row |

`at_or_null` on nested receivers returns a nullable row (`Array<int>?`,
`Type.is_nullable_array`). About 45 references to these flags across
`src/`.

## The fix

Keep `Type.elem` as the **type representation** (literals, layout,
auto-free walks and C spelling all key on it — ~110 uses), but change
**method dispatch**: a nested receiver monomorphizes `Array` with `T` =
its row type, so `Array<Array<int>>` dispatches to `Array_Array_int`
whose `T` is `Array<int>`. Every library body then works unchanged on
rows, the way `Array_List_int` already works on `List` elements.

A row value is a heap buffer pointer — 8 bytes, owned, with its own
`copy` and recursive destroy — so `T` = row behaves like an owning
class-pointer element with an array-shaped ABI.

## Steps

### 1. Mono selection (checker)

In `check_access_node`'s Array routing, when `target_type.elem` is set,
monomorphize on the row: `elem_type = Array<…>` built from
`target_type.elem` (recursively for 3+ levels), giving
`mono_type_name` = `Array_Array_int`, `Array_Array_Array_int`, ….
Static calls (`Array<Array<int>>.with(row, n)`) take the same route via
the explicit type args.

Then delete the `inline_nested_access` / `nested_checked_access` arms
that intercept `at`, `set`, `at_or`, `at_or_panic` (or keep `.at`/`.set`
inline purely as a perf fast path, now driven by the mono's element
size rather than a nested special case).

### 2. Per-instantiation constants for a row `T`

`check_function_call_node.ts` substitutes `T`, `T_SIZE`, `T_FAT`,
`T_NEEDS_STRDUP`, `T_IS_VALUE_STRUCT`, `T_HAS_COPY`/`T_copy`, `T_destroy`
by **type name string**. For a row `T` (name `Array_int`, an Array mono):

- C type: `struct Array_int *` (pointer, like a class element), not
  `struct Array_int`.
- `T_SIZE`: 8 (asm) / `sizeof(void *)` (C).
- `T_FAT`, `T_NEEDS_STRDUP`, `T_IS_VALUE_STRUCT`: 0.
- New `T_IS_ARRAY`: 1. `T_copy` → `Array_int_copy`, `T_destroy` → a
  recursive row free.

The row ABI differs from the struct `copy` ABI the `T_HAS_COPY` arm was
written for (`x0 = &src, x8 = &dst` → `x0 = src data ptr`, returns a base
pointer; C `S_copy(&x)` → `Array_int_copy(x)`). Add a `T_IS_ARRAY` arm
to `Array.copy` (and any other raw body that copies or destroys
elements) rather than overloading `T_HAS_COPY`.

`element_copy_struct` / `array_elements_copyable` extend to rows:
copyable iff the row's own elements are.

### 3. Result types: mono name → nested array type

`check_access_node`'s "Convert Array struct return type back to array
type" maps a returned `Array_<X>` to `Type(X, is_array)` by stripping the
prefix — for `Array_Array_int` that yields a flat `Array_int`-named
array. Replace it with a helper that rebuilds the `elem` chain from the
mono's `source_type_args` (and maps a bare `T` return of a row-`T` mono
to the row type). This makes `copy`, `slice`, `add`, `mul`, `with` return
correctly nested types, retiring `deep_array_copy`'s type stamping.

### 4. Receiver and value conventions (aarch64)

Rows are stored as **base** pointers (`[base]` = count); array methods
take the **data** pointer (`base + 8`). Today `is_nested_row_read`
patches one case. With rows typed as heap arrays, a row-valued
expression is just a heap-array value, and the existing "heap `Array<T>`
built by build_node → add #8" rule covers it — provided the result types
from step 3 carry `storage_kind: "heap_array"`. Then delete
`is_nested_row_read`.

### 5. C type spelling

The C backend spells every nested level `struct Array_<leaf>*`
(`array_elem_c_type`, `emit_nested_buffer_free`, literal builders). A
call into `Array_Array_int_first(struct Array_Array_int *self)` with a
`struct Array_int *` argument is an incompatible-pointer diagnostic.
Either spell each level by its mono (`struct Array_Array_int *` outer,
`struct Array_int *` rows) — the layouts are identical (`_vt`, `length`,
data) — or cast at the call boundary. Spelling by mono is cleaner and
keeps C's type checking meaningful.

### 6. Ownership of rows in library bodies

**Done for `set` (inline, not via the mono):** a nested `g.set(i, row)`
stays on the `inline_nested_access` store, which now deep-copies the value
(`deep_array_copy` helpers) and frees the displaced row (`emit_row_free`
in both backends); the checker's `hoist_row_value` makes the value a heap
row first. Routing `set` through the mono would need a callable per-row
copy/destroy symbol for the raw body, which neither backend has yet.

With `T` = an owning row, the library's value-taking bodies inherit the
owning-element contract: `set(i, value)` must take ownership of `value`
and free the displaced row (recursively); `with(row, n)` must copy the
seed per slot (else `n` slots share one buffer); `add`/`mul` must copy
rows, not memcpy pointers. These are the same rules the bodies already
follow for strings (`T_NEEDS_STRDUP`) and owning structs
(`T_TAKES_OWNERSHIP`) — extend those guards with `T_IS_ARRAY`.

Scope-exit cleanup is already correct for nested arrays (it walks
`Type.elem`), and copy results get it once step 3 types them as nested.

### 7. JS

JS arrays are untyped at runtime; `copy` already uses `__copy`. Only the
checker-side typing matters, which steps 1 and 3 fix. No JS backend
change expected beyond deleting any nested special cases.

### 8. Delete the special paths

`inline_nested_access` (or reduce it to a perf hint),
`nested_checked_access` + `build_common/nested_checked_access.ts`,
`deep_array_copy` (both backends, the `AccessFunctionCallNode` flag, the
check_access_node stamping), `is_nested_row_read`.

## Out of scope / prerequisites

- `Array<Self>` fields overflow the stack in `layout.ts` (FOLLOWUP.md) —
  independent, but worth fixing first if step 2's recursive row
  constants touch the same layout walk.

## Tests

Regression nets that must stay green: `test/nested_arrays.test.ts`,
`test/array_copy.test.ts`, `test/accessor_or.test.ts` (nested block),
`test/array_struct_fields.test.ts`, `test/memory_leaks.test.ts`, the
SPEC/README suites.

New coverage, on aarch64 + C (audit) + JS, for 2- and 3-level arrays
with int, string and mv-struct leaves:

- every Array method on a nested receiver: `first`, `at_end`, `at_or`,
  `at_or_panic`, `set`, `slice`, `copy`, `add`, `mul`, `with`;
- chained calls on the results (`g.first().at_or(0, x)`,
  `g.copy().at_end().length`);
- `set` replacing a row frees the displaced row exactly once (audit);
- `Array<Array<int>>.with(row, n)` gives `n` independent rows.

## Order and size

1 → 3 → 4 first (dispatch + result types + receiver convention: makes
`first`/`at_end` work and lets `.at` route through the mono), then 2 and
6 (row constants and ownership in the raw bodies), then 5 (C spelling),
then 8 (delete). Steps 2 and 6 are the bulk: every raw arm in
`core/System/Array.nm` needs reviewing for a row `T`. Expect several
days, landing as a sequence of commits each keeping the suite green
(steps 1–4 can land behind the existing special paths, which are then
removed in step 8).
