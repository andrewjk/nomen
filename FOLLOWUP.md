# Follow-ups

Skipped or out-of-scope items recorded for later.

2. **aarch64: `return match` with string-interpolation branches loses the
   result** (pre-existing, found while fixing the C backend's
   match-as-expression emission). The chosen branch's value is left in `x0`,
   but the branch's auto-free of the hoisted interpolation temp
   (`ldr x0, [x29, #N]; bl _nomen_free_wrap`) clobbers `x0` before the
   join-point `bl _nomen_strdup_wrap`, so the caller receives a copy of a
   freed pointer (missing/garbage output). The non-interpolation branch's
   temp is never freed either (leak). The const-declaration form and
   statement-position matches work on aarch64; only the `return match`
   form is affected. The C backend compiles and runs this form correctly
   (see `return match with interpolated string branches (C backend)` in
   test/match.test.ts).

3. **`==` on enums with associated data compares whole structs** (pre-existing,
   C backend). `if r == Result.error(5)` lowers to `r == Result_error_init(5)`
   (struct vs struct), which clang rejects. Tag-only comparison (`.tag`
   compare, possibly with payload equality) is not implemented for
   enum-with-data types on either backend; simple (payload-less) enums
   compare fine. Anonymous/generic enums inherit this unchanged.

