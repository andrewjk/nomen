# TRAITS.md — trait-typed values, and why value structs can't be traits

Why `value struct 'X' cannot be used as trait 'T'; declare 'X' as a class`
exists, what a trait-typed value actually is at runtime, and how the "use a
trait instead" pattern replaces func-typed struct fields. Everything here was
verified against both backends; the one open incoherence is recorded in
`FOLLOWUP.md` (value-struct conformers are inconsistently accepted).

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
as a trait requires *boxing*: allocate a cell, copy the bytes in, hang the
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

It is **not a fundamental impossibility** — the aarch64 backend already
boxes value-struct conformers in trait-typed locals and runs them correctly
(reassignment included). The gap is coherence: the checker mostly rejects
value-struct conformers, aarch64 boxes them, and C mis-specializes the local
to the concrete struct type (so reassignment to a different conformer is a
raw clang type error). See FOLLOWUP.md for the two clean resolutions.

## "Use a trait instead": the strategy pattern

The checker rejects func-typed struct fields
(`struct fields cannot be function types — use a trait instead`). The
substitute is a one-method trait: the trait method plays the role of the
stored function, and the conformer's fields hold whatever state the function
needs. TS's rule object:

```ts
type BlockRule = { test: (line: string) => boolean }
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
  supported; SPEC "Function Types"). Only the *field* case is rejected.
- A rule/renderer family → one trait + class per rule (current port shape),
  until/unless func-typed fields land.
