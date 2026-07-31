# Tree

## `struct Tree<T>`

A tree of values connected by parent/child links

**Members:**

- `add(T value)`
- `set_left(int idx, int left)`
- `set_right(int idx, int right)`
- `left(int idx) -> int`
- `right(int idx) -> int`
- `parent_of(int idx) -> int`
- `first() -> T`
- `at(int idx) -> T`
- `count_nodes(int idx) -> int`
- `length() -> int`
