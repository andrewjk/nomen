---
nomen-lang: minor
nomen: minor
---

!Fix: mark System library internals `internal` so they leave the API reference

BREAKING: about 180 storage fields and helpers documented as internal (e.g. `List.items`, `Map.used`, `Task.future`, `Channel.mu`, `File.raw_open`, `Container`'s layout buffers) can no longer be used outside `System`; use the public methods instead.
