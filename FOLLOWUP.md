# Follow-ups

Skipped or out-of-scope items recorded for later.

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
