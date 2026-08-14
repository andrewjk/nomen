# Follow-ups

Skipped or out-of-scope items recorded for later.

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
