---
nomen-lang: patch
---

Fix the nursery futures list overflowing at 64 concurrent spawns (fixed stack array -> heap list on the C backend, pointer slot on aarch64); un-skips and passes the concurrent Tcp echo test at 256 connections on both backends
