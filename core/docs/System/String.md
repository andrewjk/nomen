# String

## `struct string`

A UTF-8 text string — a heap-owned, length-tracked sequence of bytes

**Members:**

- `to_string() -> string`
- `at(int index) -> char`
- `slice(int start, int end) -> view string`
- `set(int index, char value)`
- `add(string other) -> string`
- `mul(int count) -> string`
