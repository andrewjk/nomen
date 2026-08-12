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

## `List<string>` owning extraction (`pop`) of a static-literal element — aarch64

Sibling to the value-struct-element work, but `string` is a **primitive** (not a
value struct), so the Buffer owning-element specialisation does not apply.
`Buffer<string>` stores shallow-copied `char*` pointers (the slot does not own
an independent copy). Owning extraction is therefore unsound for a literal:

- **aarch64**: `List<string>.pop` is `mov out T` (`owned_return`), so the caller
  anchors and frees the result. If the element was `push`'d as a bare literal,
  the slot holds a `char*` into rodata — `free` aborts (SIGABRT). The C backend
  strdup's the `move_T` result at the `List.pop` return, so it is sound; aarch64
  does not, so it crashes. (`push`/`at`/`set`/iterate — the borrow paths — are
  unaffected on both backends.)
- A latent related gap: `Buffer<string>.#destroy` frees only the slab (the slots
  are borrows), so heap-string elements pushed from concatenation leak at
  destroy. Not exercised by current tests (they pop or outlive the strings).

**Two sound options for a future pass** (both touch the string-ownership logic
shared with `Map<K,string>`/`Set<string>` values, so neither is a one-liner):

1. Make `Buffer<string>` owning (strdup on `store_T`, per-slot free on
   `replace_T`/`#destroy`) — symmetric with the value-struct-element
   specialisation, fixes both the pop crash and the destroy leak, but the C
   return-path strdup for `move_T`/`pop` would then double-allocate and must be
   gated off.
2. Make aarch64 match C (strdup the `move_T`/`pop` result at the return site).
   Smaller, but leaves the destroy leak and is a backend-specific patch.

Until then, a one-field `pub class` wrapper (the port's `Token`) sidesteps it
(`ClassBuffer<string-wrapper>` owns/frees the pointer soundly and `pop` works).

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
