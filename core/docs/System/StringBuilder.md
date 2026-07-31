# StringBuilder

## `struct StringBuilder`

A growable byte buffer for incrementally building strings (O(1) amortized append)

**Members:**

- `ensure(int needed)`
- `append_char(char c)`
- `append_string(string s)`
- `to_string() -> string`
