---
nomen-lang: minor
---

Control events beyond clicks: on_focus / on_blur (first-responder snapshot edges) and on_input (per-text-change), each with its own synthesized dispatcher and App trait default

Also: event-routing precedence — a declared event API (`on_<event>(id)` on the widget) wins over the builtin table on any receiver, so Control-conforming composites and non-GUI (voice-only) widgets define their own events without touching the compiler's event table.
