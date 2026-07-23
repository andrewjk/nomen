# Ownership & Borrows

Nomen's memory is cleaned up automatically at scope exit (see
[MEMORY.md](MEMORY.md)). On top of that, Nomen has a small ownership system for
**class instances** — the only heap-allocated, mutable values — to make
single-ownership and borrowing explicit and statically checked.

This document describes the rules as shipped today. For the user-facing surface,
see the "Ownership & Borrows" section of [README.md](README.md); for value-type
cleanup see [MEMORY.md](MEMORY.md).

## `mov` — single ownership

`mov` marks a class-typed value as **owned**: there is exactly one owner, and
moving it transfers ownership (the previous binding becomes invalid).

### Owning fields

A class-typed field must be declared with `mov`. Value-type fields use `var` as
usual.

```nomen
class Box {
    var int value
}

class Holder {
    mov Box content   // owned — Holder is responsible for freeing it
    var int scratch   // value type
}
```

- Structs **cannot** hold class-typed fields at all (use a class instead —
  structs are value types and can't own heap resources cleanly).
- Traits follow the same rule as classes: a class-typed field must be `mov`.
- `mov` is only allowed on class types (and generic type parameters, which may
  bind to a class at the call site). `mov int` or `mov Point` is a compile
  error.

### Owning parameters

A `mov` parameter takes ownership from the caller. The caller must mark the
argument with `mov` too, and the moved binding is invalid afterwards:

```nomen
func take = (mov Box b) {
    Console.write("\{b.value}")
}

var b = Box(42)
take(mov b)
// b is invalid here — using it is a compile error
```

Moving the same value twice is a compile error:

```nomen
take(mov b)
take(mov b)   // Error: b was already moved
```

## `ref` — borrows

`ref` passes a value by reference so a function can mutate the caller's
variable. Unlike `mov`, the caller keeps ownership. The `ref` keyword is
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
class Holder {
    mov Box content
    var int scratch
    func poke = (ref self) {
        self.scratch = self.scratch + 1
    }
}
```

## Borrow invalidation

A **child-group borrow** is a class reference taken from a class field or a
container element (e.g. `var Box b = h.content`, or `var Animal a =
list.at(0)`). It is rooted at the owner (`h`, `list`).

When the owner is mutated — typically through a `ref self` method
call, which may free or displace the contents the borrow points into — all
live child-group borrows rooted at that owner are **invalidated**. Using one
after that point is a compile error:

```nomen
var Holder h = Holder(mov Box(1), 0)
var Box b = h.content      // child-group borrow rooted at h
h.poke()                   // mutates h → b is invalidated
Console.write("\{b.value}") // Error: borrow invalidated
```

Re-fetching the borrow after the mutation is fine:

```nomen
h.poke()
var Box b2 = h.content     // fresh borrow — allowed
```

Object-level aliases (`var q = p`, where both are the same class instance) are
**not** child-group borrows, so mutating one does not invalidate the other.
This is the mutable-aliasing benefit over Rust's "aliasing xor mutability":
Nomen allows multiple references, and keeps it sound by invalidating borrows
**on mutation** rather than forbidding the alias.

## `swap` — move out, replace in place

`swap` atomically moves an owned value out of a field and substitutes a fresh
one, so the field is never left empty. It requires `mov`:

```nomen
class Box { var int value }
class Holder { mov Box content }

var h1 = Holder(mov Box(1))
var h2 = Holder(mov Box(2))
h1.content = h2.content swap Box(0)
// h1.content now owns the old h2 Box; h2.content owns Box(0)
```

- `swap` without `mov` is a compile error ("swap requires mov").
- The replacement value's type must match the field's type.

## `ref self` vs `var self` vs `self`

| Form       | Mutates instance  | Notes                                                                    |
| ---------- | ----------------- | ------------------------------------------------------------------------ |
| `self`     | read-only         | default for struct/trait methods                                         |
| `var self` | local copy        | mutations are not visible to the caller (value types)                    |
| `ref self` | through reference | mutations are visible to the caller; participates in borrow invalidation |

## Implementation status

- `mov` fields, `mov` parameters, double-move detection, and the
  "class-type fields must use `mov`" / "structs cannot hold classes" rules are
  enforced at compile time on both backends.
- Child-group borrow invalidation is enforced statically (parse/check phase).
- `swap` and its `mov` requirement are enforced at compile time.
- Open work: recursive `#destroy` of `mov`-owned class fields only frees one
  level deep today (see `test/recursive-destroy-leak.test.ts`).
