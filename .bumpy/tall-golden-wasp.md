---
nomen-lang: minor
nomen: minor
---

!Feat: for ref is a native element borrow
BREAKING: the loop variable now aliases the element slot — writes land in the array immediately (an in-body read of the array sees them) instead of at the iteration's end; programs relying on the deferred write-back see the new value sooner
