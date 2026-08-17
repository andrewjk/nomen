# Option

## `enum Option<T>`

A generic optional type with a `some(T value)` case and a `none` case.
Monomorphized per concrete type argument (e.g. `Option<int>`).

```
func find_first_even = (int[] xs, out Option<int>) {
    for x of xs {
        if x % 2 == 0 {
            return .some(x)
        }
    }
    return .none
}

const found = find_first_even([1, 3, 4])
match found {
    case .some(v) -> Console.write("\\{v}")
    case .none -> Console.write("none")
}
```
