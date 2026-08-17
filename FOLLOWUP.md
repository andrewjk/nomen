# Follow-ups

Skipped or out-of-scope items recorded for later.

3. **`==` on enums with associated data compares whole structs** (pre-existing,
   C backend). `if r == Result.error(5)` lowers to `r == Result_error_init(5)`
   (struct vs struct), which clang rejects. Tag-only comparison (`.tag`
   compare, possibly with payload equality) is not implemented for
   enum-with-data types on either backend; simple (payload-less) enums
   compare fine. Anonymous/generic enums inherit this unchanged.
