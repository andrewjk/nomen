# Buffer

## `struct Buffer<T>`

A flat, low-level buffer of value slots of type T — the backing store for arrays and collections

**Members:**

- `alloc(int size) -> int`
- `grow(int needed) -> int`
- `zero(int len)`
- `load(int i) -> uint32`
- `store(int i, uint32 val)`
- `store_or(int i, uint32 val)`
- `alloc_int(int size) -> int`
- `grow_int(int needed) -> int`
- `load_int(int i) -> int`
- `store_int(int i, int val)`
- `move_int(int i) -> int`
- `replace_int(int i, int val)`
- `zero_int(int len)`
- `alloc_T(int size) -> int`
- `grow_T(int needed) -> int`
- `load_T(int i) -> T`
- `store_T(int i, T val)`
- `slice(int start, int end) -> view T`
- `zero_T(int len)`
- `store_or_int(int i, int val)`
- `alloc_float(int size) -> int`
- `load_float(int i) -> float`
- `store_float(int i, float val)`
