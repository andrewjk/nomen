# Json

## `struct Json`

JSON serialization helpers — `serialize`/`deserialize` strings, `parse`/`stringify` via a JsonTree

**Members:**

- `serialize(string value) -> string`
- `deserialize(string json) -> string`
- `parse(string s, ref JsonTree tree) -> int`
- `stringify(ref JsonTree tree, int root) -> string`
