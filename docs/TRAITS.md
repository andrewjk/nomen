# TRAITS.md — trait-typed values, and why value structs can't be traits

Why `value struct 'X' cannot be used as trait 'T'; declare 'X' as a class`
exists, what a trait-typed value actually is at runtime, and how the "use a
trait instead" pattern replaces func-typed struct fields. Everything here was
verified against both backends. The one deliberate exception to the
blanket rule — trait-typed _locals_ — is specified below ("The two-tier
rule").

## What a trait-typed value is at runtime

A trait-typed value (`var BlockRule rule = ...`) is a **reference to a
heap instance whose leading word(s) identify the concrete conformer**.
Dispatch is dynamic:

```c
// Generated C sketch (from a real build):
unsigned char a = ((unsigned char (*)(void *, nomen_string))
    _get_trait_func(&rule, 0, 0))(&rule, nomen_str_lit("# heading", 9));
```

`_get_trait_func(obj, trait_index, func_index)` inspects the object's tag to
find the implementation belonging to its concrete type, then calls it
indirectly. A `class` instance has that header because it is heap-allocated
by construction.

Assignment through a trait slot maintains the invariant: the previous
instance is destroyed/re-tagged (the `<Trait>_destroy` shims, anchor slots,
and `trait_class_locals` in the aarch64 backend), so the slot always holds a
validly-tagged instance the slot's scope exit can release.

## Why a value struct can't be used as one

**1. No header, no heap.** A value struct is its fields, inline — a stack
slot, a container element, a field. There is no leading tag for
`_get_trait_func` to read and nothing heap-allocated to point at. Using it
as a trait requires _boxing_: allocate a cell, copy the bytes in, hang the
tag on it.

**2. Boxing flips the semantics.** Value structs copy by value and die at
scope exit. Classes have identity, shared mutability, and `move` ownership —
and the trait machinery assumes the latter (destroy/re-tag on assignment, as
above). A boxed value struct blurs the two: is the trait reference an alias
of the original or a copy? Who frees the box, and does the value's own
destroy run?

**3. Hidden allocation.** Boxing inserts an invisible malloc at every
trait conversion. Nomen keeps allocations explicit and auditable (see
MEMORY.md and the leak-audit posture), so a silent box on each coercion is
against the grain of the design.

## The two-tier rule

The blanket rule has one deliberate exception, and it stops exactly where
the pointer representation would be needed:

**Tier 1 — trait-typed locals may hold a value-struct conformer inline.**

```nomen
var Rule r = HeadingV()   // value struct: OK — inline storage, no heap
r.test("# heading")       // dispatch resolved through the bound conformer
r = HeadingV()            // same conformer: OK
```

No cell is allocated: the slot is sized by the initializer's conformer,
dispatch is resolved through it (aarch64: inline storage + a scope-keyed
dispatch record; C: the concrete-struct declaration with `&local` vtable
dispatch), and the slot keeps that conformer for its whole lifetime.
Reassignment must therefore reuse the SAME conformer — storing a different
value-struct conformer, a class instance, or anything whose conformer isn't
statically known is a check error (`value-struct trait slot 'r' is bound to
'HeadingV' and cannot hold …`), because the bytes wouldn't fit or wouldn't
carry the right identity. Copies of the slot (`var Rule r2 = r`) re-bind
the same conformer and copy inline. Copying a CLASS-backed slot (`var Rule
b = a`, a initialized from a class) is rejected: it would need non-owning
alias semantics over the shared heap instance, which trait slots don't
provide — the original binding is the shareable reference.

**Tier 2 — everything that crosses a call or container boundary requires a
class.** A trait-typed parameter, a class's trait field, a collection
element, or a trait-typed local passed as an argument all hold the pointer
representation (heap instance + vtable header). Value-struct conformers are
rejected in every one of those positions with
`value struct 'X' cannot be used as trait 'T'; declare 'X' as a class` —
the language does not box implicitly.

That is the whole contract. There is no third tier: a value struct never
gains a header, and no coercion ever allocates.

## "Use a trait instead": the strategy pattern

The checker rejects func-typed struct fields
(`struct fields cannot be function types — use a trait instead`). The
substitute is a one-method trait: the trait method plays the role of the
stored function, and the conformer's fields hold whatever state the function
needs. TS's rule object:

```ts
type BlockRule = { test: (line: string) => boolean };
```

becomes (verified on both backends):

```nomen
trait BlockRule {
    func test = (self, string line, out bool)
}

class HeadingRule : BlockRule {
    pub func test = (self, string line, out bool) {
        return line.at_or(0, ' ') == '#'
    }
}

class QuoteRule : BlockRule {
    pub func test = (self, string line, out bool) {
        return line.at_or(0, ' ') == '>'
    }
}

// "Calling the field": indirect dispatch through the trait tag
func try_rule = (BlockRule rule, string line, out bool) => rule.test(line)
```

Rules must be **classes** (value structs can't be trait-typed, per above),
which buys the semantics a rule usually wants anyway: reference identity,
`move` into containers/tables, shared caches. What it costs versus a func
field: one wrapper class per function — the reason a first-class
`func`-typed field feature remains interesting (a capture-less function
value is just a code pointer, so the field would be pointer-sized; the work
is indirect-call lowering and `#init`/copy/move semantics in both backends).

## Rules of thumb

- Polymorphism with state or identity → `class : Trait`, hold as `Trait`.
- A pure function value → func-typed **local or parameter** (fully
  supported; SPEC "Function Types"). Only the _field_ case is rejected.
- A rule/renderer family → one trait + class per rule (current port shape),
  until/unless func-typed fields land.
- A polymorphic value confined to ONE function's body → a value struct
  conformer in a trait-typed local is fine (two-tier rule, tier 1); the
  moment it must cross a call or container boundary, promote it to a class.
