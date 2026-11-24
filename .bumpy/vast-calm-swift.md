---
nomen-lang: minor
nomen: minor
---

Method receivers: instance methods (and #destroy/#init) must declare self, ref self is required to write fields — including in #init — capital-S Self is rejected in favour of #self, and the static/instance call forms are enforced at call sites (no static keyword)
