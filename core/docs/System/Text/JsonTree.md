# JsonTree

## `struct JsonTree`

A flat, pool-backed set of JSON tree nodes — the parsed representation `Json.parse` produces

**Members:**

- `alloc_node() -> int`
- `reset()`
- `set_text(int idx, string text)`
- `set_kind(int idx, int val)`
- `set_child(int idx, int val)`
- `set_next(int idx, int val)`
- `set_val(int idx, int val)`
- `get_kind(int idx) -> int`
- `get_text(int idx) -> string`
- `get_text_view(int idx) -> view string`
- `take_text(int idx, ref StringBuilder sb)`
- `get_child(int idx) -> int`
- `get_next(int idx) -> int`
- `get_val(int idx) -> int`
