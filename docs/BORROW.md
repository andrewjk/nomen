# Ownership & Borrows

Nomen's memory is cleaned up automatically at scope exit (see
[MEMORY.md](MEMORY.md)). On top of that, Nomen has a small ownership system for
**owning values** — `mv struct`s, `mv enum`s, `Box<T>` slots, and `string` —
the values that hold heap resources, to make single-ownership and borrowing
explicit and statically checked.

This document describes the rules as shipped today. For the user-facing surface,
see the "Ownership & Borrows" section of [README.md](README.md); for value-type
cleanup and the full memory model see [MEMORY.md](MEMORY.md).

## `mv` — single ownership

`mv struct` declares the single-owner, move-only form: its bindings MOVE
instead of copy, and the declaration — not a field walk — is the ownership
contract. `string` is a declared `mv` type too, and `Box<T>` is the owned
heap slot. Moving a value transfers ownership; the previous binding is
invalid:

```nomen
mv struct Token {
    var int value
}

var Token p = Token(10)
mv Token q = p        // transfer: q owns it now
// p.value            // Error: Variable 'p' used after mv
```

A plain binding copy of a mv value is a compile error — spell what you mean:

```nomen
var Token q = p       // Error: cannot copy 'Token' by value —
                      //   it owns heap resources; use .copy() or mv
var Token r = p.copy()  // deep copy: p stays valid
```

(`string` has the same rule with its own wording: "cannot copy a string by
value — it owns its bytes; use 'mv' to transfer it, or .copy() for a deep
copy".)

### Owning fields

An `mv struct`'s mv-typed field (`Box<T>`, another mv struct, a mv enum) is an
owned slot. **Ownership follows the field's type, so the spelling is plain
`var`** — no `mv` field keyword exists. Construction and stores transfer, the
field is destroyed with the struct, and a re-assignment reclaims the displaced
value:

```nomen
mv struct Config {
    var string name
}

mv struct Holder {
    var Config config   // owned slot: Holder(mv c) transfers
    var int scratch     // value type
}
```

- A bare `struct` is Copyable, so it cannot hold these fields — the Copyable
  verifier rejects it, naming the fix:
  `'Wrapper' cannot be Copyable — field 'c' owns heap memory --> mark the
struct `mv struct Wrapper`, or remove the field`.
- `mv` is allowed on class, trait, and mv struct types. `mv int` or `mv Point`
  (a Copyable struct) is a compile error:
  "mv is only allowed for class, trait, or mv struct types, not 'Point'".
- A trait-typed field is not supported yet — declare the concrete type or
  `Box<Concrete>` (the boxed-handle field lowering is pending; see
  FOLLOWUP.md).

### Owning parameters

A `mv` parameter takes ownership from the caller. The caller must mark the
argument with `mv` too, and the moved binding is invalid afterwards:

```nomen
func take = (mv Token t, out int) {
    return t.value
}

var Token p = Token(42)
var int v = take(mv p)
// p is invalid here — using it is a compile error
```

Moving the same value twice is a compile error:

```nomen
take(mv p)
take(mv p)   // Error: Variable 'p' used after mv
```

A `mv` argument must be an OWNED value — a fresh constructor, an owned local,
or a `mv out T` accessor result (`.pop()`, `Buffer.move_T(i)`). Moving a
borrow into a `mv` parameter is rejected (it would create shared ownership).

## `ref` — borrows

`ref` passes a value by reference so a function can mutate the caller's
variable. Unlike `mv`, the caller keeps ownership. The `ref` keyword is
required at **both** the definition and the call site, so mutation is never
silent:

```nomen
func make_five = (ref int x) {
    x = 5
}

var int n = 1
make_five(ref n)
// n is now 5
```

`ref self` lets a method mutate the instance it is called on:

```nomen
mv struct Holder {
    var int scratch

    func poke = (ref self) {
        self.scratch = self.scratch + 1
    }
}
```

A `const` binding cannot be borrowed mutably — `ref` requires a mutable value, so
the caller's binding must be `var`:

```nomen
var int n = 1
make_five(ref n)   // OK

const int c = 1
make_five(ref c)   // Error: Cannot pass const 'c' to ref parameter 'x'
```

Plain parameters are read-only for every type; take one by value and make a
local `var` copy if you need a mutable scratch value the caller never sees.

## Borrow invalidation

A **child-group borrow** is a pointer-backed value taken from an owner's
interior — a `Box<T>`/trait-typed field read (`var Box<Data> b = h.data`) or a
method returning one. It is rooted at the owner variable (`h`).

When the owner is mutated — typically through a `ref self` method
call, which may free or displace the contents the borrow points into — all
live child-group borrows rooted at that owner are **invalidated**. Using one
after that point is a compile error:

```nomen
var Holder h = Holder(0, mv Box<Data>(Data(1)))
var Box<Data> b = h.data    // borrow rooted at h
h.poke()                    // mutates h → b is invalidated
Console.write("\{b.value}") // Error: Borrow 'b' was invalidated by a
                            //   mutation of its owner of 'h';
                            //   re-fetch it after the mutation
```

Re-fetching the borrow after the mutation is fine:

```nomen
h.poke()
var Box<Data> b2 = h.data   // fresh borrow — allowed
```

The invalidation is whole-receiver: any `ref self` call on the owner
invalidates every borrow rooted at it, even one that only writes an int
field (field-scoped effect precision is a recorded follow-up in FOLLOWUP.md).

Two shapes do NOT create invalidatable borrows:

- **Reading an inline mv-struct field by value is rejected** — the read would
  byte-copy a value that owns heap resources. Move it out with a swap
  (below), which revalidates the field.
- **Container element reads are deep copies** (`List`/`Buffer`'s
  copy-on-store), so the reader owns its value and owner mutation cannot
  dangle it — re-fetching an element after a push is fine. The one
  exception is the element-load pure borrow: a `.at()` read of an element
  whose destroy-worthy state cannot be privatized (a `#destroy` over a
  non-string field — an AppKit-style handle — a nested destroy struct
  without a `copy`, an owned func field). The binding aliases the slot's
  resource, so it is policed like any borrow: a `ref self` call on the
  container invalidates it, it cannot move through `mv`, and nothing is
  destroyed at its scope exit (the slot's destroy stays the only one).

Object-level aliases (`ref Box<Token> q = b`, where both names are the same
heap instance) are **not** child-group borrows, so mutating one does not
invalidate the other. This is the mutable-aliasing benefit over Rust's
"aliasing xor mutability": Nomen allows multiple references, and keeps it
sound by invalidating borrows **on mutation** rather than forbidding the
alias. A `ref` alias mutates through to the shared instance (source must be
`var`), while assigning to the alias re-points the alias itself — it adopts
the assigned instance into its own slot and stops aliasing (the owner keeps
its instance). Ownership never transfers through it (mv the owner instead) —
see MEMORY.md, "Spelled aliases with `ref`".

## `view` — non-mv borrows

`view T` is the cheap non-mv borrow. `string.slice(start, end)` returns a
`view string` — an O(1) `(ptr, len)` borrow of the source's buffer. The
checker guarantees a view can't outlive its source and is invalidated once
the source is reassigned (which frees the buffer it points into):

```nomen
var string s = "hello world"
view v = s.slice(0, 5)               // borrows from s
Console.write(v.to_string())         // "hello" — materializes an owned copy
s = "changed"                        // frees s's old buffer → v dangles
Console.write("\{v.length}")         // Error: Borrow 'v' was invalidated by
                                     //   a mutation of its owner of 's'
```

View borrows are invalidated eagerly on reassignment (unlike Box child-group
borrows, which survive owner reassignment through deferred reclamation): the
old buffer is actually freed. A struct whose fields are views is poisoned
wholesale — if one field's source mutates, reads through its sibling view
fields are rejected too.

## `swap` — move out, replace in place

`swap` atomically moves an owned value out of a binding or field and
substitutes a fresh one, so the source is revalidated instead of left empty.
The moved side must be spelled `mv`:

```nomen
// declaration form: b receives the old value, h.content holds the replacement
var Box b = mv h.content swap Box(0)

// assignment form: h1 takes h2's old value; h2 is revalidated (no mv needed —
// the swap itself is the transfer)
h1.data = h2.data swap Box<Data>(Data(0))

// call-site form: the argument transfers out of the field, the field is
// revalidated
take(mv h.content swap Box(0))

// strings: transfer out and revalidate with the empty string
var string b = mv a swap ""
```

- A `swap` argument without `mv` is a compile error ("swap requires mv
  keyword").
- The replacement value's type must match the source's type.

## `ref self` vs `self`

| Form       | Mutates instance  | Notes                                                                    |
| ---------- | ----------------- | ------------------------------------------------------------------------ |
| `self`     | read-only         | default for struct/trait methods                                         |
| `ref self` | through reference | mutations are visible to the caller; participates in borrow invalidation |

Methods that need to write the instance declare `ref self`. A bare `self` is an
immutable borrow — assigning to its fields is a compile error ("Cannot mutate
'self' — it is immutable; declare as 'ref self' to allow mutation").

## Implementation status

- `mv struct` declarations, `mv` parameters, use-after-move detection, and the
  Copyable verifier ("a bare struct cannot hold mv-typed fields") are enforced
  at compile time on both backends.
- Child-group borrow invalidation is enforced statically (check phase), rooted
  at the ultimate owner variable name; branch/loop invalidations merge
  conservatively.
- Element loads of destroy-aliasing structs (the `List<Own>.at()` shape) are
  classified as pure borrows at compile time: no scope-exit destroy on the
  binding, container-mutation invalidation, `mv`-transfer rejection
  (`element_load_aliases_destroy_state`; `test/list-own-at.test.ts`).
- View borrows are scope-checked (a borrow may not escape the scope it was
  taken in) and invalidated on source reassignment.
- `swap` and its `mv` requirement are enforced at compile time.
- Recursive `#destroy` of mv-owned fields frees the full subtree (the
  one-level-deep bug is closed — see `test/recursive-destroy-leak.test.ts`,
  now a passing regression test). Remaining open work: per-field invalidation
  precision and the trait-typed field lowering are recorded in FOLLOWUP.md.
