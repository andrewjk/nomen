nomen-lang: minor
---

Own the spawn env's packed arguments (deep-copied strings, copied-and-destroyed owning structs) so tasks cannot dangle their donors' buffers; allow non-Sendable class arguments inside nurseries as join-bounded borrows (detach still requires owned args); add the Awaitable trait (Task<T> conforms); and make cancellation observable to channel-waiting thread tasks with the nursery join waiting for done after cancel
