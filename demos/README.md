# Nomen Demos

## Todo

A GUI app with a todo list.

## Async

A GUI app that fetches five letters (A-E) in parallel. The Fetch button
starts a coordinator fiber whose `async { }` nursery spawns five threads —
each sleeps a random 1-10 s (via `Random`), then reports its letter down a
`Channel`. The letters therefore arrive in **completion order**, so each run
prints a different order, e.g. `Done! B E D A C`. The label flips to
"Fetching..." immediately; the event loop stays responsive by polling the
coordinator's `Task.is_done()` instead of blocking.
