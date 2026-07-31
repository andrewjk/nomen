# Map

## `struct Map<TK, TV>`

An ordered key-value map with `set`/`get`/`has`/`remove`

**Members:**

- `set(TK key, TV value)`
- `get(TK key) -> TV`
- `has(TK key) -> bool`
- `remove(TK key) -> void`
- `find_slot(TK key, int cap) -> int`
- `rehash(int new_cap)`
