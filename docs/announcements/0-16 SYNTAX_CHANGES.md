# Nomen 0.16: the syntax cleanup

0.16 retires the syntax debts we did not want to carry into 1.0 — spellings
that were ambiguous, redundant, or carried meaning they should not have.
Ten breaking changes, most of them one-line mechanical migrations where the
compiler names the old spelling and offers the fix. Two are behavior, not
spelling: bitwise precedence, and `for ref` writing through the element
slot. Everything in this document is already migrated — SPEC, README, the
core library, the demos and the whole test suite run on the new language,
so the docs never show a retired spelling.

## The catch-all arm moves inside the braces: `case _`

`match` and `switch` close their catch-all arm inside the case braces like
every other arm — the `} else` spelling, which terminated the construct at
the top level, is gone:

```nomen
// 0.15
match n {
    case 0 -> "zero"
    case 1 -> "one"
} else -> "many"

// 0.16
match n {
    case 0 -> "zero"
    case 1 -> "one"
    case _ -> "many"
}
```

```nomen
// 0.15
switch {
    case n < 10 -> "small"
} else -> "large"

// 0.16
switch {
    case n < 10 -> "small"
    case _ -> "large"
}
```

The rules that the top-level `else` never quite said out loud are now
structural: the catch-all must be the **last** arm and appears **at most
once**. It is required when the construct is used as an expression value;
an enum `match` without one must cover every case, and a `bool` match must
cover `true` and `false`. (The compile-time `#switch` keeps its
`} else { ... }` — that `else` selects compilation targets, not values, and
is unchanged.)

## One-line branches take `->`; blocks yield with `let`

`let` and `->` used to be interchangeable branch introducers, which made
both noise. Now the shape picks the introducer: a **one-line** arm
introduces its value with `->`, and a **block** arm yields its value with
`let`:

```nomen
// 0.15
const y = if x > 5 let 50 else let 0

// 0.16
const y = if x > 5 -> 50 else -> 0
```

```nomen
// 0.15
const y = if x > 5 { -> 0 } else { -> 50 }

// 0.16
const y = if x > 5 { let 0 } else { let 50 }
```

`let` is still not a function return — a function produces its value with
an explicit `return`, unchanged.

## `=>` is the lambda introducer only

`=>` used to substitute for `return` in branch and statement positions —
`if x => y`, `case 1 => "one"`, `#switch` arms, a bare `=> expr`, even
`return => expr`. All of those are gone: `=>` introduces lambdas and does
nothing else. Branch values take `->` (one-line) or `let` (blocks), and a
function returns with `return`:

```nomen
// 0.15 — `=>` stood in for a return in branches and statements
var label = if done => "finished"
match n {
    case 1 => Console.write("one")
}

// 0.16 — branch values use `->`, statements use their own block
var label = if done -> "finished"
match n {
    case 1 -> Console.write("one")
}
```

Lambdas keep the arrow they always had:

```nomen
var func (out int) f = () => answer
```

## `panic` and `todo` take parentheses

The bare keyword-with-message form is a parse error; the message goes in
parentheses like every other call:

```nomen
// 0.15
panic "index out of range"
todo "wire up the parser"

// 0.16
panic("index out of range")
todo("wire up the parser")
```

## Owning fields spell `mv`

Ownership moved from inferred to spelled on the slot. A field of `string`,
`Box<T>`, mv-struct, mv-enum or trait-handle type — an _owning slot_ —
declares `mv`, and a transfer into it spells `mv` on the store:

```nomen
// 0.15
mv struct Holder {
    var string name
    var Box<Stats> stats
}
self.name = owned

// 0.16
mv struct Holder {
    mv string name
    mv Box<Stats> stats
}
self.name = mv owned
```

Fresh values never take `mv` — there is no owner to surrender:

```nomen
self.name = "literal"     // fresh: no mv
item = Item()             // fresh: no mv
```

Type-parameter fields (`var T value`) stay implicit — whether the slot owns
is decided by the specialization.

## `private` retires

Visibility is `pub`, `internal`, and the unmarked spelling — which was
already the tightest scope (file-scoped at the top level). `private` is a
compile error pointing at the unmarked form.

The model underneath got stated properly while the keyword retired:
visibility tracks the **compilation unit**, not the naming tree.
`internal` means the whole declaring library — every namespace in it — and
a consumer (a program outside the library) sees only `pub`. Namespaces are
the import path, not a visibility boundary. Struct, enum and `extend`
members default `pub`; a trait's members are exported with its contract (an
`internal` trait member is rejected).

One migration consequence: `private` used to keep a field out of the
auto-generated `#init`. Every field without a default value is now a
constructor parameter — give a retired-private field a default if it should
stay out of the constructor.

## Type parameters spell `type T`

The reversed comptime type-parameter spelling no longer parses. Type
parameters use the ordinary `Type name` order:

```nomen
// 0.15
func zero = (T: type, out T) {
    var x = T()
    return x
}

// 0.16
func zero = (type T, out T) {
    var x = T()
    return x
}
```

Old declarations get a named retirement diagnostic and recover, so the
migration is mechanical.

## The `ufloat` family retires

`ufloat`, `ufloat32` and `ufloat64` no longer exist. They promised
unsignedness and enforced nothing — a `ufloat` happily held
`2.0 - 4.0` (that is, `-2.0`). Use the signed `float` family. A `ufloat`
declaration gets a named retirement diagnostic and recovers, so a mixed
codebase keeps compiling while it migrates.

## Bitwise binds tighter than comparisons

Operator precedence for the mixed case flipped to the Go/Rust order:
**bitwise operators bind tighter than comparisons**. An expression mixing
the two without parentheses changes meaning:

```nomen
// 0.15: flags & (mask == mask)
// 0.16: (flags & mask) == mask
if flags & mask == mask { ... }

// 0.15: (x == a) | b
// 0.16: x == (a | b)
x == a | b
```

The new order is the reading everyone writes anyway — `flags & mask ==
mask` now parses as the mask test it looks like. Code that silently relied
on the old parse should parenthesize to pin its meaning; the natural
readings no longer need parentheses at all.

## `for ref` writes through the slot

`for ref x of arr` is a true element borrow: the loop variable binds the
element's slot, so a write lands in the array **immediately** — visible to
later reads of the array (and to any alias) inside the same iteration.
Arrays are fixed-length, so the slot address is stable for the loop's
lifetime.

```nomen
for ref p of arr {
    p.x = 9
    if arr.at(0).x == 9 {   // sees the write — 0.15 saw the old value
        Console.write("live")
    }
}
```

In 0.15 the shapes that did not take the borrow (scalar and string
elements, bodies that touch the container) copied the element out and wrote
it back at the iteration's end — an in-body read of the array saw stale
values. That deferred write-back is gone: there is one semantics, and it is
the aliasing one.

---

## The short version

Three tweets plus a code sample.

**1.**

> Nomen 0.16 retires the catch-all `} else`: match and switch close their
> catch-all inside the braces as `case _` — last arm, at most once. Branch
> values untangle too: one-line arms introduce with `->`, blocks yield with
> `let`, and `=>` is the lambda introducer only.

**2.**

> The spelling pass: `panic("msg")` and `todo("msg")` take parentheses;
> `private` retires (visibility is `pub`/`internal`/unmarked — compilation
> unit, not naming tree); owning fields declare `mv` and transfers spell it
> on the store; comptime type params are `type T`, not `T: type`.

**3.**

> Two meaning changes: bitwise binds tighter than comparisons (the Go/Rust
> order — `flags & mask == mask` finally parses as the mask test), and
> `for ref x of arr` writes through the element slot immediately — no
> end-of-iteration write-back. Plus: the `ufloat` family is gone; use
> `float`.

**The one code sample** — the same program in both spellings:

```nomen
// ─── 0.15 ────────────────────────────────────────────────
mv struct Badge {
    var string label
    private var int seq = 0
}

pub func main = () {
    var labels = ["a", "bb"]
    var pick = if labels.length > 1 let labels.at(1) else let "none"
    var grade = match labels.length {
        case 1 -> "thin"
    } else -> "roomy"
    if labels.length == 0 => panic "no labels"
    Console.write("\\{grade} \\{pick}")
}

// ─── 0.16 ────────────────────────────────────────────────
mv struct Badge {
    mv string label
    var int seq = 0
}

pub func main = () {
    var labels = ["a", "bb"]
    var pick = if labels.length > 1 -> labels.at(1) else -> "none"
    var grade = match labels.length {
        case 1 -> "thin"
        case _ -> "roomy"
    }
    if labels.length == 0 {
        panic("no labels")
    }
    Console.write("\\{grade} \\{pick}")
}
```
