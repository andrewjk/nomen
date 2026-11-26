---
nomen-lang: minor
nomen: minor
---

!Fix: binding a heap array is spelled (mv q / q.copy()); fix mv bindings and string-array literals
BREAKING: const w = q on an Array<T> is an error (it shares the buffer); write mv q or q.copy()
