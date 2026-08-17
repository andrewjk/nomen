# Result

## `enum Result<T, E>`

A generic result type with an `ok(T value)` success case and an
`error(E error)` failure case. Monomorphized per concrete type-argument pair
(e.g. `Result<int, string>`).

```
func parse_age = (string s, out Result<int, string>) {
    return .error("not a number")
}

const result = parse_age("x")
match result {
    case .ok(age) -> Console.write("\\{age}")
    case .error(msg) -> Console.write("error: \\{msg}")
}
```
