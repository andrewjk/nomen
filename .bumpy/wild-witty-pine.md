---
nomen-lang: minor
nomen: minor
---

!Fix: let yields blocks, -> one-liners only
BREAKING: `let` no longer introduces a one-line branch value (`if x let "yes"` → `if x -> "yes"`, match/switch arms already rejected it), and `->` no longer yields a block branch (`{ -> "yes" }` → `{ let "yes" }`) — one-line branches take `->`, block branches yield with `let`
