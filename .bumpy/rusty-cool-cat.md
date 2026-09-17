---
nomen-lang: patch
---

Fix folded store addressing on aarch64: the region-bracket base-fold's bare-induction register was dropped when the tranche-K hoist block was removed, so store_int through a folded base indexed with a stale staging register (edigits segfault, pidigits wrong digits)
