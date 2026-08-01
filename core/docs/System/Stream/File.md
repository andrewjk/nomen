# File

## `struct File`

A file handle for reading and writing (`open`/`close`/`readAll`/`writeLine`/…),
plus static one-shot helpers `exists`, `delete`, `read_all`, `write_all`

**Members:**

- `open(string path, string mode)`
- `close()`
- `readAll() -> string`
- `writeAll(string data)`
- `readLine() -> string`
- `writeLine(string data)`
- `readChunk(int size) -> string`
- `writeChunk(string data, int size)`
- `exists(string path) -> bool`
- `delete(string path)`
- `read_all(string path) -> string`
- `write_all(string path, string data)`
