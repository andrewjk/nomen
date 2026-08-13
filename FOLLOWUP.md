# Follow-ups

Skipped or out-of-scope items recorded for later.

## Owning value-struct elements in containers — DONE

`Buffer` value-struct elements whose only owning fields are `string`s (including
those nested inside further owning value structs) now work soundly in containers
on **both** backends. The fix has five parts:

1. **`Buffer.store_T` deep-copies string fields** (strdup per field) when the
   element type is a value struct with string fields, so the slot owns an
   independent heap copy — no pointer sharing between the slot and the source.
2. **`Buffer.replace_T` destroys the old slot value** (calls the element's
   `T_destroy`) before overwriting, so the replaced element's strings are freed.
3. **`Buffer.#destroy` calls `T_destroy` per element**, then frees the slab.
4. **`T_destroy` is auto-generated** for any value struct whose fields include a
   `string` (or a nested owning value struct). It frees each string field.
5. **Nested owning value structs now actually work** (this round). A struct that
   embeds another owning value struct (`Outer { Inner inner }` where `Inner` has
   a string) previously LEAKED on aarch64 and failed to compile on C — see
   ROADBLOCKS ("`Array<T>` / `List<T>` of value-struct `T` — FIXED", nested
   follow-on). Two fixes: (a) C `build_struct_body` now emits an embedded
   value struct's full typedef **before** the containing struct's, in whichever
   buffer (code/header) the body lands — so a header typedef of `Outer` pulls
   `Inner`'s typedef into the header too (previously `struct Inner inner;` was
   an incomplete type); (b) aarch64 `emit_field_destroys` now calls a nested
   struct's **auto-generated** `_destroy` (not only an explicit `#destroy`), so
   `Outer_destroy` chains into `Inner_destroy` which frees the string.

Struct locals are **not** destroyed at scope exit — their string fields may be
raw arg pointers (static literals, or hoisted temps the existing scope-exit
cleanup already handles). The only path that calls `T_destroy` is the Buffer
per-element destroy (where every string was strdup'd by `store_T`, guaranteeing
heap). This avoids the double-free and static-literal-crash problems that
previously made per-element destroy unsound.

The specialisation is emitted at build time (both backends) when the Buffer's
element type is detected as an owning value struct. On the C backend,
`build_struct_functions` intercepts the raw-block body and emits generated C.
On aarch64, the standalone `build_struct_functions` path and the inline
`build_inline_method` path both intercept; `#destroy` is intercepted in
`build_struct_node`.

**Class fields are not a limitation — they are guarded.** A non-class struct
cannot have a field of class OR trait type at all: `struct fields cannot be
class/trait types, use a class instead` is enforced at check time
(`check_struct_node.ts`), for direct fields, unbounded generic args, AND
bounded generic args (the check re-runs on the monomorphised struct). So the
deep-copy specialisation never needs to handle a reference-typed field — such a
struct is unrepresentable. Class/trait elements of a container route through
`ClassBuffer<T>`, which owns/destroys the single pointer soundly. (A `class`
may still have trait/class fields, since a class is itself a reference type.)

Regression tests: `test/list.test.ts` ("List of owning value structs") covers
flat string-field structs (push/at/return/set/heap-strings) and now nested
(push/at, set, two-level deep); `test/mov-ownership.test.ts` locks the
class/trait-field guard (direct + class-with-trait-field allowed).

## `List<string>` owning extraction (`pop`) of a static-literal element — DONE

`List<string>.pop` of an element `push`'d as a bare literal no longer crashes
on aarch64. The aarch64 backend now strdup's the `move_T` result at the `pop`
return site (option 2 from the original note below), mirroring the C backend,
which already strdup's the borrow there. The caller frees the fresh heap copy
instead of a rodata pointer. See ROADBLOCKS (`List<string>` caveat, now
marked FIXED) for the full detail and the two aarch64 infrastructure fixes
(`current_function_name` for struct methods + `last_result_is_heap` reset)
that landed alongside it.

The "make `Buffer<string>` owning" alternative (option 1) was prototyped and
rejected: it double-strdup's in the `move_T`→`set` path that `Map<K,string>`/
`Set<string>` rehash uses, leaking at every rehash.

**Remaining gaps (not fixed by the return-site strdup):**

- `Buffer<string>.#destroy` still frees only the slab (the slots are shallow
  borrows), so a heap-string element (e.g. from concatenation) that outlives
  the pop leaks at destroy. Not exercised by current tests.
- `mov string` parameters are not freed at function exit — only `mov` _class_
  params are registered for auto-free (`build_function_node`: the
  `param.is_moved && param_struct?.is_class` gate). So a heap string moved
  into a `mov T value` param (e.g. `xs.push(heapConcatenation)`) leaks the
  original when the callee strdup's/shallow-copies it into its own storage.
  Pushing a string _variable_ by value (no `mov`) is unaffected (the param
  holds a borrow, the caller still owns and frees the original).

## `clone_node` drops check-phase annotations on AccessFunctionCallNode

`clone_node`'s `access_func` case (`src/nodes/clone_node.ts`) copies
`mangled_name`, `ref_param_indices`, `mov_param_indices`, `swap_params`,
`allocations`, and `variadic_param_name` — but drops `owned_return`,
`nullable_param_indices`, `variadic_param_index`, `return_bounds`,
`inferred_array_length`, `is_nursery_spawn`, `function_return_type`, and
`skip_bounds_check`. These are check-phase annotations that the
monomorphized body depends on (it is never re-checked: `cloned.checked =
true`). In practice the only one with a currently-demonstrable footprint is
`owned_return` (the internal `move_T` call inside a mono `List.pop` body),
and it is masked there by name-based heuristics in the build — so copying it
is correct but doesn't currently change observable behavior. Compounding the
drop, monomorphization clones the body _before_ the original is checked
(verified by tracing: CLONE runs with `owned_return=undefined`, CHECK sets it
on the original afterward), so even copying the flag at clone-time would be a
no-op for the mono body. A robust fix would re-derive these annotations in a
post-clone pass (or close the clone-before-check ordering gap); neither is
needed for the `pop` fix (which works at the return site instead), so both
are punted here.

## `Array<T>` materialization — finish the exclusion list

`T[]`→`Array<T>` param materialization (ARRAY.md §"Materialising `T[]`
values") deliberately excludes three cases, which keep the old
compile-mismatch behavior:

1. `ref Array<T>` params — a copy can't propagate mutation back to the
   caller's variable.
2. Class-element arrays — owned layout interactions not yet worked out.
3. Owning value-struct elements (string fields) — container ownership is now
   sound (`store_T` deep-copies, per-element `#destroy`; see the closed
   "Owning value-struct elements in containers" item above), but the
   `T[]`→`Array<T>` _materialisation copy itself_ still shallow-copies, so a
   stack array of owning value structs materialised into a heap `Array_<T>`
   would share string pointers. Needs the same deep-copy on the materialise
   path (or a check-time reject).

These should either gain their own sound materialization path or be formally
rejected at check time with a diagnostic (today they silently fall back to the
old raw-pointer codegen).
