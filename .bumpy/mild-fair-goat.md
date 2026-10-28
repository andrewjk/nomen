---
nomen-lang: minor
nomen: minor
---

Feat: in-place push for constructor arguments — push(Res(...)) constructs directly into the container's fresh slot on both backends; the temp home, the callee-side slot copy and the teardown disappear (shape micro-bench: C -55%, aarch64 -58%)
