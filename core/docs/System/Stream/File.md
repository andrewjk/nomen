# File

## `struct File`

A file handle for reading and writing (`open`/`close`/`readAll`/`writeLine`/…)

**Members:**

- `open(string path, string mode)`
- `close()`
- `readAll() -> string`
- `writeAll(string data)`
- `readLine() -> string`
- `writeLine(string data)`
- `readChunk(int size) -> string`
- `writeChunk(string data, int size)`
