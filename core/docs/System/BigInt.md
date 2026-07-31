# BigInt

## `struct BigInt`

An arbitrary-precision integer

**Members:**

- `new(int val) -> BigInt`
- `get(int i) -> uint64`
- `set(int i, uint64 val)`
- `data_ptr() -> uint64`
- `get_at(uint64 ptr, int i) -> uint64`
- `set_at(uint64 ptr, int i, uint64 val)`
- `ensure(int needed)`
- `clear(int len)`
- `copy_range_from(BigInt src, int start, int count)`
- `add_at(BigInt other, int shift)`
- `sub_at(BigInt other, int shift)`
- `div128(uint64 hi, uint64 lo, uint64 d) -> uint64`
- `mul_wide_hi(uint64 a, uint64 b) -> uint64`
- `cmp(BigInt other) -> int`
- `add_to(BigInt a, BigInt b) -> void`
- `sub_to(BigInt a, BigInt b) -> void`
- `mul_to(BigInt a, BigInt b, ref BigInt scratch) -> void`
- `div_to(BigInt a, BigInt b, ref BigInt remainder) -> void`
- `to_digit() -> int`
- `copy_from(BigInt other)`
- `set_int(int val)`
- `set_u64(uint64 val)`
