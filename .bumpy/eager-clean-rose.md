---
nomen-lang: patch
---

Fix: Window.process_events drains an autorelease pool per pump (the manual loop leaked tens of MB/s: unbounded autoreleased AppKit objects)
