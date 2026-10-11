# Nomen vs. Valen's Group Borrowing

A comparison against Valen's "flexible borrow checker" —
[Valen's Memory Safety: A New Kind of Borrow Checking](https://verdagon.dev/blog/valen-group-borrowing)
(Evan Ovadia, 2026-10-11) — and the group-borrowing proposal it builds on.
Written 2026-10-12 to record where Nomen stands on the same problems, what is
worth taking from the design, and where Nomen already differs by choice.

> Note: [`docs/BORROW.md`](./BORROW.md) still teaches retired syntax (`mov`,
> class-era rules — see FOLLOWUP.md "Docs debt"); the Nomen rules cited here
> come from [MEMORY.md](./MEMORY.md) and the checker source instead.

## Valen's model in brief

Valen keeps single ownership (like Nomen, Rust, C++) but attaches two ideas
to it:

- **Paths.** Every object is described by a path from its owner:
  `world.entities[]`, `world.entities[].hp`. Every reference _remembers the
  path it points into_ — a parameter can be typed
  `entity in world.entities[] mut`, i.e. "a reference to one of `world`'s
  entities' elements, writable".
- **Mutability as a function effect, not a type.** There is exactly one kind
  of borrow reference. A mutating method declares `mut(self)` (sugar:
  `self &Vec<T> mut`) as part of its _signature_, not its parameter types.
  Callers use that to know precisely what was invalidated.

Safety rule: when an object at path P is modified/destroyed, references
pointing _inside_ P are invalidated; using one is a compile error. This
relaxes "shared-xor-mutable" to "no use-after-free" — multiple references to
one object may all read and write it, as long as invalidation is respected
when the object's _interior_ is displaced or freed.

On top of that: **Mutable-in-Immutable** (mutate one element group while the
containing object stays read-only), **temporary uniqueness** (hand a Valen
reference to Rust as `&mut` when provably exclusive for the call),
**wildcard descendant paths** (`in self.gem...` — "somewhere inside", for
interop), a planned **type-stability exception** (mutations never invalidate
pointers to type-stable sub-objects like a struct's `int` fields), and a
planned blend with reference counting. Evan's own footnote: group borrowing
is "a sort of compile-time generational reference."

## How Nomen stacks up on the same examples

Nomen already made Valen's core trade — invalidation-on-mutation instead of
aliasing-xor-mutability — with a simpler tracker:

- **Multiple read-write references** (his `ref_a.push(42); ref_b.push(73)`
  example): Nomen allows this today. Object-level aliases (`ref Box<Token> q
= b`) name the same instance, mutation through any alias is visible, and
  aliases do not invalidate each other. This is Valen's headline feature.
- **Use-after-free caught at compile time** (his `world.entities = new
Vec; first_ref.hp` example): the analogous Nomen program is rejected.
  Child-group borrows — a container element fetched from an owner, or a
  field-access borrow — root at the owner variable, and a `ref self` call on
  that owner invalidates them
  (`invalidate_borrows_of`, `src/check/utils/borrow.ts`; called at
  `src/check/check_access_node.ts:907`).
- **Linear types / use-after-move**: both languages have single ownership
  with explicit transfer (Nomen: `mv`, rejected re-use until reassignment;
  `swap` to move out of a field with a replacement). Parity.

The divergence is **granularity**. Nomen's "path" is a single root variable
name: `borrow_owner_of` resolves every borrow to its ultimate owner, and
_any_ `ref self` call on that owner invalidates _all_ borrows rooted at it:

```nomen
mv struct Holder {
    var int scratch
    var Box<Data> data

    func poke = (ref self) {
        self.scratch = self.scratch + 1
    }
}

var Holder h = Holder()
var Box<Data> b = h.data   // child-group borrow rooted at h, via `data`
h.poke()                    // writes only `scratch`...
                            // ...but b is invalidated anyway (today)
```

Valen's paths make `poke` invalidate only references pointing inside
`world.scratch`; the `data` borrow survives. The same coarseness is what
forces Rust's re-fetch dance in his `step(world, entity)` example:

```nomen
// Valen:
func step(world &World, entity in world.entities[] mut) {
    entity.advance()
    let collision = world.get_collision_for_entity(entity)
    entity.resolve(collision)
}
```

In Nomen this works _as long as_ the reads are read-only: a bare-`self`
method does not invalidate anything, so an entity borrow survives
`world.get_collision_for_entity(entity)`. The gap opens only when one part
of the hierarchy must _mutate_ while another part is borrowed — then Nomen's
whole-receiver invalidation forces the borrow to be re-fetched (or the
mutating methods to be restructured). Valen's `mut(world.entities[])`
effect names exactly what the callee may touch.

## What is worth stealing

1. **Field-scoped invalidation** — the cheap, high-value piece. Record which
   owner _field_ each borrow came through (`borrowed_via`), compute a
   per-method effect set (which fields a `ref self` method might displace or
   free, including mutator calls like `self.items.push(...)` and the union
   of callees' effects), and invalidate only borrows rooted at those
   fields. Value-type fields drop out entirely — writing an `int` can't free
   anything — which is the Nomen-shaped version of Valen's type-stability
   exception. Full sketch in FOLLOWUP.md ("Field-scoped borrow
   invalidation"). No path algebra needed; sound fallback to today's
   behavior keeps it incremental.
2. **Mutable-in-Immutable** (bigger lift, maybe later). A way to say "this
   function may mutate inside `world.entities[]` and nothing else" — a
   stronger API contract (nothing in the body can touch the rest of the
   world) and an optimizer hint (fine-grained may-write information). Valen
   gets it from path-typed parameters; a Nomen version would likely be a
   declared effect on the method, not a parameter type.
3. Not worth stealing: **wildcard descendant paths** (Nomen's re-root-at-
   `self` return convention for method borrows already approximates "points
   somewhere inside the receiver"), **temporary uniqueness** (that exists to
   bridge Rust's `&mut`; Nomen's raw `#arch` boundaries don't carry a borrow
   calculus across), and the **RC blending** (see below).

## Where Nomen differs by choice

- **Compile-time bounds contracts.** Valen's Rust comparisons keep tripping
  over bounds checks and panics; group borrowing sidesteps indexing via
  references, but indexing still pays a runtime check. Nomen proves most
  indices in bounds at compile time — parameter constraints on accessors
  (`at(index: index >= 0 && index < self.length)`) discharged by
  flow-sensitive analysis over loop ranges, conditions, and return
  contracts, with unprovable indices rejected outright (MEMORY.md,
  "Compile-time bounds checking"). Orthogonal to borrowing; rare among
  languages; complementary to Valen's mechanism.
- **No reference counting needed.** Valen's next posts blend in RC to
  handle graphs, observers, and back-pointers. Nomen already covers those
  deterministically: `WeakHandle<T>` — a generational (pointer, generation)
  slot table, the Vale-style runtime mechanism — for the cyclic/back-pointer
  cases, and arena containers (flat `Buffer`s, single owner, flat free) for
  graph shapes. Notably, Evan calls group borrowing a "compile-time
  generational reference"; Nomen is unusual in shipping _both_ halves of
  that idea — the compile-time one (invalidation) and the runtime one
  (`WeakHandle`) — without GC or RC.
- **Deferred reclamation.** Same-scope owner reassignment frees the old
  instance at scope exit rather than eagerly, so in-scope borrows stay
  valid (MEMORY.md, "Borrow Lifetimes"). Valen would invalidate eagerly
  here. The philosophies are opposite: Nomen biases toward "don't free
  while borrowed" (cost: peak memory), Valen toward "invalidate precisely,
  free eagerly" (cost: false positives without path precision). Both are
  sound; worth naming because it explains why the same program can be
  accepted by one and rejected by the other.
- **Enum payload safety by construction.** The tagged-union hazard Valen's
  type-stability machinery exists to manage — invalidate interior
  references when an enum changes variant — cannot arise in Nomen: no
  interior reference into an enum payload can be created (MEMORY.md,
  "Tagged-union type confusion").
- **It ships.** Nomen's tracker is a scope-depth + owner-name scheme with a
  single invalidation call site and branch-union persistence
  (`persist_invalidated`), enforced on both backends, with an audit runtime
  (`--audit` allocation counting) backing the memory tests. Valen's design
  needs path types in signatures, a mut-effect calculus, and possibly LLVM
  patches (their footnote 42); its type-stability exception and unique
  groups are explicitly unimplemented at writing. This is not a knock —
  Valen's precision is the point — but it does mean Nomen's model is
  verifiable and extendable one conservative step at a time.

## Honest gaps the post exposes

- **Mutate-one-part-while-borrowing-another** (the `step` case): Nomen
  handles the read-only callee case cleanly but re-fetches under mutual
  mutation. Field-scoped invalidation (item 1 above) narrows this;
  full Mutable-in-Immutable would close it.
- **Many structs referencing a common subsystem** (his `File` →
  `FileSystem` example, zero-cost in group borrowing): Nomen rejects `ref`
  fields outright (a non-mv borrow field could outlive its target), so the
  shape costs a `WeakHandle` slot lookup at runtime or a restructure.
- **Containers of view-carrying structs** are not lifetime-checked against
  their borrow sources (documented limitation, MEMORY.md "Struct Layout");
  Valen's paths would cover this uniformly.

## Pointers

- Checker machinery: `src/check/utils/borrow.ts` (`borrow_depth_of`,
  `borrow_owner_of`, `receiver_owner_of`, `invalidate_borrows_of`,
  `invalidate_view_borrows_of`, `persist_invalidated`); invalidation call
  site `src/check/check_access_node.ts` (the `ref self` arm).
- Memory model: [MEMORY.md](./MEMORY.md) — "Borrow Lifetimes",
  "Compile-time bounds checking", `WeakHandle`, "Tagged-union type
  confusion".
- Follow-up sketch: FOLLOWUP.md, "Field-scoped borrow invalidation
  (Valen-style effect precision)".
