# Set

## `struct Set<T>`

An ordered set of unique values (`add`/`has`/`get`/`remove`)

**Members:**

- `add(T value)`
- `has(T value) -> bool`
- `get(T key) -> T`
- `remove(T value) -> void`
- `find_slot(T value, int cap) -> int`
- `rehash(int new_cap)`
