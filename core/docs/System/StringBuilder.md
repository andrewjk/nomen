# StringBuilder

## `struct StringBuilder`

A growable byte buffer for incrementally building strings (O(1) amortized append)

**Members:**

- `ensure(int needed)`
- `append_char(char c)`
- `append_int(int n)`
- `append_float(float f)`
- `append_string(string s)`
- `append(view string s)`
- `append(int n)`
- `append(float f)`
- `append(char c)`
- `to_string() -> string`
