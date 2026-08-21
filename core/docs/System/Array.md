# Array

## `struct Array<T>`

A fixed-length array of values, created with a literal (`[1, 2, 3]`) and addressable by index

**Members:**

- `at(int index) -> T`
- `at_or(int index, T fallback) -> T`
- `at_or_panic(int index) -> T`
- `first() -> T`
- `set(int index, T value)`
- `at_end() -> T`
- `slice(int start, int end) -> view T`
- `with(T value, int count) -> T[]`
- `add(Array other) -> Array`
- `mul(int other) -> Array`
