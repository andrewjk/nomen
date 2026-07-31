# ClassBuffer

## `struct ClassBuffer<T>`

A flat buffer of owned class pointers of type T — the backing store for collections of classes

**Members:**

- `alloc_int(int size) -> int`
- `grow_int(int needed) -> int`
- `load_int(int i) -> int`
- `store_int(int i, int val)`
- `move_int(int i) -> int`
- `replace_int(int i, int val)`
- `slice(int start, int end) -> view T`
