# JsonTree

## `struct JsonTree`

A flat, buffer-backed pool of JSON tree nodes — the parsed representation `Json.parse` produces

**Members:**

- `alloc_node() -> int`
- `free_text(int idx)`
- `reset()`
- `set_text(int idx, string text)`
- `set_kind(int idx, int val)`
- `set_child(int idx, int val)`
- `set_next(int idx, int val)`
- `set_val(int idx, int val)`
- `get_kind(int idx) -> int`
- `get_text(int idx) -> string`
- `get_child(int idx) -> int`
- `get_next(int idx) -> int`
- `get_val(int idx) -> int`
