---
nomen-lang: patch
nomen: patch
---

Fix the lint pass being suppressed by internal errors on synthesized nodes (`start: -1`) — warnings now run whenever the checker reports no user-addressable errors, so `nomen check` surfaces them for programs with string-field structs and auto-derived `copy` bodies. Also exempts the synthesized `copy` field store from the copy-out-of-a-field rejection (it strdups by design), and adds a `Use 'const'` quick fix to the var-never-changed warning.
