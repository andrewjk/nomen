# Result

## `must_use enum Result<T, E>`

A generic result type with an `ok(T value)` success case and an
`error(E error)` failure case. Monomorphized per concrete type-argument pair
(e.g. `Result<int, string>`).

`Result` is declared `must_use`: a statement-position call that returns a
`Result` is a compile error unless the value is bound or matched. Ignore it
deliberately with `var _ = f.close()`, or handle both cases with `match`.

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
