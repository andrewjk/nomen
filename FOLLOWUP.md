# Follow-ups

Skipped or out-of-scope items recorded for later.

## Deep-const for collections (design question)

Nomen's `const` on a collection is **shallow** — it prevents rebinding the
collection but does not deeply freeze its contents. Today you can do:

```nomen
const List<Button> buttons = ...
var b = buttons.at(0)   // .at takes plain self (read-only), works on const
b.title = "Click"       // mutates the class instance through the const list
```

If const collections should be deeply immutable (preventing mutation of
extracted class references), that's a broader borrow-system change. Not
specific to for-loops; needs a separate design decision.
