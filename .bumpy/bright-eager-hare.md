---
nomen-lang: minor
nomen: minor
---

!Fix: => is lambda-only; branches use ->
BREAKING: `=>` no longer substitutes for `return` in branch or statement positions (`if x => y`, `case .a => y`, `#switch` arms, a bare `=> expr`, and `return => expr`) — it is the lambda introducer only; use `->` for a one-line branch value or `return` for a function return
