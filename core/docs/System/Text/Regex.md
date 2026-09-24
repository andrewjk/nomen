# Regex

## `struct Regex`

Regular-expression helpers (`test`/`match`/`count`/`replace_all`) using POSIX ERE syntax plus `(?:...)`, lookaround, and `{n,m}` counted repetition

**Members:**

- `test(string pattern, string input) -> bool`
- `match(string pattern, string input) -> string`
- `count(string pattern, string input) -> int`
- `replace_all(string pattern, string input, string replacement) -> string`
