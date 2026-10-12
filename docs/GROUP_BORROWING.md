# Nomen vs. Valen's Group Borrowing

A comparison against Valen's "flexible borrow checker" —
[Valen's Memory Safety: A New Kind of Borrow Checking](https://verdagon.dev/blog/valen-group-borrowing)
(2026-10-11) — and the group-borrowing proposal it builds on, as discussed
on [HN](https://news.ycombinator.com/item?id=50042362),
[Reddit](https://www.reddit.com/r/ProgrammingLanguages/comments/1x37bbs/valens_memory_safety_a_new_kind_of_borrow_checking/),
and [Lobsters](https://lobste.rs/s/gmnqhj/valen_s_memory_safety_new_kind_borrow).
Written 2026-10-12 to record what each language offers, where they diverge,
and what is worth taking from the design.

## Valen's model

Valen keeps single ownership (as in Rust, C++) but attaches two ideas to it:

- **Paths.** Every object is described by a path from its owner:
  `world.entities[]`, `world.entities[].hp`. Every reference _remembers the
  path it points into_ — a parameter can be typed
  `entity in world.entities[] mut`, i.e. "a reference to one of `world`'s
  entities' elements, writable".
- **Mutability as a function effect, not a type.** There is exactly one kind
  of borrow reference. A mutating method declares `mut(self)` (sugar:
  `self &Vec<T> mut`) as part of its _signature_, not its parameter types.
  Callers use that to know precisely what was invalidated.

Safety rule: when an object at path P is modified or destroyed, references
pointing _inside_ P are invalidated; using one is a compile error. This
relaxes "shared-xor-mutable" to "no use-after-free" — multiple references to
one object may all read and write it, as long as invalidation is respected
when the object's _interior_ is displaced or freed.

The relaxation is additive: Valen retains the ability to express
shared-xor-mutable. A `mut` effect on a group with no `in`-declared aliases
is effectively a unique reference; references with no `mut` effects are
effectively shared; mutable aliasing is the opt-in, so code drifts toward
exclusivity by default.

On top of that:

- **Mutable-in-Immutable** — mutate one element group while the containing
  object stays read-only (`entity in world.entities[] mut`).
- **Temporary uniqueness** — hand a Valen reference to Rust as `&mut` when
  provably exclusive for the call.
- **Wildcard descendant paths** — `in self.gem...`, "somewhere inside", for
  interop and API flexibility.
- **Path unions** (planned) — a reference that may live at one of several
  paths, for conditionally-returned references.
- **Type-stability exception** (planned) — mutations never invalidate
  pointers to type-stable sub-objects (a struct's `int` fields, fixed-size
  arrays), only interiors of type-unstable things (enum contents, pointees).
- **A blend with reference counting** (planned) — describe RC'd classes to
  the borrow checker as groups, so borrows can reach into them.

The model is essentially a compile-time generational reference: the checker
remembers where each reference points, the way a generational reference
remembers its target's generation. ("Path borrowing" is the direction the
name is drifting, since groups aren't central to the idea.)

Control flow: branch invalidations merge. A loop's invalidations are scouted
and replayed before the body — a reference can outlive an iteration, so a
conservative pre-pass hoists them.

## Nomen's model

Nomen makes the same core trade — invalidation on mutation instead of
aliasing-xor-mutability — with a scope-depth + owner-name tracker instead of
paths:

- **Single ownership with explicit transfer.** `mv` moves; re-use after a
  move is rejected until reassignment; `swap` moves out of a field with a
  replacement.
- **Object-level aliases are lenient.** `ref Box<T> q = b` names the same
  heap instance; mutation through any alias is visible; aliases never
  invalidate each other. One boundary: the same object may not arrive as
  two `ref` parameters of one call — `attack(ref list, ref list)` is
  rejected ("Aliasing: 'list' passed as both 'a' and 'b' — mutable
  parameter aliasing can cause use-after-free"), so aliasing freedom is a
  local-alias affair, not a signature affair.
- **Box-field reads are borrows** rooted at the owner variable
  (`borrow_owner_of`); any `ref self` call on the owner invalidates them
  (`invalidate_borrows_of`, `src/check/utils/borrow.ts`, called at
  `src/check/check_access_node.ts:907`).
- **Container element reads are copies** (Buffer deep-copy-on-store):
  owner mutation or replacement cannot dangle them, so there is nothing to
  invalidate.
- **View borrows** (`view string` slices, `view T` accessors) root at their
  source variable and are invalidated by source mutation or reassignment.
- **Structs carrying view fields are poisoned wholesale**: if any one
  field's source mutates, reads through the other view fields are rejected
  too.
- **`ref self` is the mut effect**; bare-`self` methods are read-only and
  invalidate nothing — the immutability exemption is structural.
- **Deferred reclamation.** Same-scope owner reassignment frees the old
  instance at scope exit, not eagerly, so in-scope borrows stay valid
  (MEMORY.md, "Borrow Lifetimes").

## Where the models diverge

The divergence is **granularity**. Nomen's "path" is a single root variable
name, and _any_ `ref self` call on that root invalidates _all_ borrows
rooted at it:

```nomen
import System

mv struct Data {
	var int value
}

mv struct Holder {
	var int scratch
	var Box<Data> data

	func poke = (ref self) {
		self.scratch = self.scratch + 1
	}
}

pub func main = () {
	var h = Holder(0, mv Box<Data>(Data(1)))
	var Box<Data> b = h.data   // borrow rooted at h, via `data`
	h.poke()                    // writes only `scratch`...
	                            // ...but b is invalidated anyway
	Console.write_line("\{b.value}")
}
// Error: Borrow 'b' was invalidated by a mutation of its owner of 'h';
// re-fetch it after the mutation
```

Valen's paths would make `poke` invalidate only references pointing inside
`h.scratch`; the `data` borrow survives. (A `mv h.data swap …` transfer of a
user mv struct revalidates instead — the swap result is owned, so `poke`
can't hurt it.)

The same coarseness shows up in the `step(world, entity)` shape:

```nomen
// Valen:
func step(world &World, entity in world.entities[] mut) {
    entity.advance()
    let collision = world.get_collision_for_entity(entity)
    entity.resolve(collision)
}
```

In Nomen the same program is spelled Rust-shaped — the world plus an index
carrying a compile-time bounds contract (the user-suggested
`entity_id: entity_id >= 0 && entity_id < world.entities.length`). The
contract discharges the bounds checks inside the body and is proven at the
call site by flow analysis (a length guard, a loop range); unprovable call
sites are rejected outright. Because element reads are copies, the mutated
element is written back at the end — the one step Rust doesn't need, and in
exchange no re-fetch per use (a copy can't be invalidated the way a `&mut`
must be dropped). Prints `0` (10 + 1 − 11):

```nomen
import System

mv struct Entity {
	var int hp

	func advance = (ref self) {
		self.hp = self.hp + 1
	}

	func resolve = (ref self, int collision) {
		self.hp = self.hp - collision
	}
}

mv struct World {
	var List<Entity> entities

	func collision_for = (self, Entity entity, out int) {
		return entity.hp
	}
}

func step = (ref World world, int entity_id: entity_id >= 0 && entity_id < world.entities.length) {
	var Entity entity = world.entities.at(entity_id)
	entity.advance()
	const collision = world.collision_for(entity)
	entity.resolve(collision)
	world.entities.set(entity_id, mv entity)
}

pub func main = () {
	var world = World(List<Entity>())
	world.entities.push(mv Entity(10))

	if world.entities.length > 0 {
		step(ref world, 0)
	}

	Console.write_line("\{world.entities.at_or_panic(0).hp}")
}
```

Drop the length guard and the call is rejected:
`Parameter constraint cannot be verified: entity_id`. What remains of the
gap: when one part of the hierarchy must _mutate_ while another part is
borrowed, Nomen's whole-receiver invalidation forces a re-fetch (or a
restructure), where Valen's `mut(world.entities[])` effect names exactly
what the callee may touch — and Rust's shared-xor-mutable forces the same
re-fetching, plus a panic check per fetch.

And view fields have their own coarseness: one mutated source poisons every
view field of a struct, not just the one that dangled:

```nomen
import System

struct Holder {
	var view string first
	var view string second
}

pub func main = () {
	var a = "aaaa"
	var b = "bbbb"

	var h = Holder(a.slice(0, 2), b.slice(0, 2))

	Console.write_line(h.first.to_string())

	a = "XXXX"   // mutates only `first`'s source

	Console.write_line(h.second.to_string())
}
// Error: view field 'second' was invalidated by a mutation of its
// source; re-fetch it after the mutation
```

Control flow: Valen's checker scouts a loop body's invalidations and
replays them before the body, because a reference there can outlive an
iteration. Nomen's branch union (`persist_invalidated`) performs the same
merge, and the loop replay is unnecessary: borrows are scope-bound and
loop-body locals are cleaned up each iteration (MEMORY.md, "Loops"), so no
borrow exists across iterations for a pre-pass to hoist. Pinned by probe
tests in
[test/borrow-loop-invalidation.test.ts](../test/borrow-loop-invalidation.test.ts):
a borrow taken before a loop, invalidated by a `ref self` call inside the
body, is rejected after the loop (for and while, including a branch-union
case); a body-local borrow invalidated later in the same body is rejected;
a use before the invalidating call — or a re-fetch after it — is accepted.

## The blog's examples in Nomen

Every full program below was written against the current language
(`List<T>`, `Box<T>`, `ref`/`view`/`mv`), checked with `nomen check`, and
run on the aarch64 backend from this tree (2026-10-12); the two error
examples check with exactly the error shown. Expected output or the exact
compile error is noted under each.

**1. Two read-write references to one list** (the headline
`ref_a.push(42); ref_b.push(73)` example). Local aliases of a heap-resident
list; both mutate, neither invalidates the other — prints `2`:

```nomen
import System

pub func main = () {
	const Box<List<int>> list = Box<List<int>>(List<int>())

	ref Box<List<int>> ref_a = list
	ref Box<List<int>> ref_b = list

	ref_a.push(42)
	ref_b.push(73)

	Console.write_line("\{list.length}")
}
```

(The parameter-spelled version — `attack(ref list, ref list)` — is
rejected; see the aliasing note above.)

**2. Use-after-free caught at compile time** (`world.entities = new Vec;
first_ref.hp`). Both halves, because Nomen's answer differs by shape. The
element read is a copy, so Valen's rejected program is _correct_ here — the
copy owns its `hp` and nothing dangles; prints `42`:

```nomen
import System

mv struct Entity {
	var int hp
}

pub func main = () {
	var list = List<Entity>()

	list.push(mv Entity(42))
	const Entity first = list.at_or_panic(0)

	list = List<Entity>()

	Console.write_line("\{first.hp}")
}
```

The Nomen program that IS rejected is the one holding a real borrow across
the mutation — a `view` slice invalidated by its source's reassignment:

```nomen
import System

pub func main = () {
	var s = "entities"

	var view string v = s.slice(0, 3)

	s = "replaced"

	Console.write_line("\{v.length}")
}
// Error: Borrow 'v' was invalidated by a mutation of its owner of 's';
// re-fetch it after the mutation
```

**3. `step(world, entity)`** — mutate one element while reading the world.
Same signature shape as the Rust contrast in the post: the world plus an
index, with a compile-time bounds contract in place of Rust's panic check.
The contract discharges the `at`/`set` bounds checks in the body and is
proven at the call site; the mutated copy is written back at the end
(the one step Rust skips — but Nomen never re-fetches, because a copy
can't be invalidated). Prints `0` (10 + 1 − 11):

```nomen
import System

mv struct Entity {
	var int hp

	func advance = (ref self) {
		self.hp = self.hp + 1
	}

	func resolve = (ref self, int collision) {
		self.hp = self.hp - collision
	}
}

mv struct World {
	var List<Entity> entities

	func collision_for = (self, Entity entity, out int) {
		return entity.hp
	}
}

func step = (ref World world, int entity_id: entity_id >= 0 && entity_id < world.entities.length) {
	var Entity entity = world.entities.at(entity_id)
	entity.advance()
	const collision = world.collision_for(entity)
	entity.resolve(collision)
	world.entities.set(entity_id, mv entity)
}

pub func main = () {
	var world = World(List<Entity>())
	world.entities.push(mv Entity(10))

	// the call site proves the constraint
	if world.entities.length > 0 {
		step(ref world, 0)
	}

	Console.write_line("\{world.entities.at_or_panic(0).hp}")
}
```

Without the guard, the call is rejected:
`Parameter constraint cannot be verified: entity_id`. Valen's version
avoids all three costs — no re-fetch (the reference stays live), no
write-back (mutation is in place), no index at all (the path IS the
reference); its signature, `func step(world &World, entity in
world.entities[] mut)`, also pins the callee to the `entities` group while
Nomen's and Rust's signatures accept a whole-`World` mut reference.

**4. `vec_ref` survives `push`, `elem_ref` does not.** In Nomen both
survive: the alias is never invalidated, and the element read is a copy —
the dangling shape is unspellable for container elements. Prints `42 3`:

```nomen
import System

mv struct Ship {
	var int fuel
}

pub func main = () {
	const Box<List<Ship>> vec = Box<List<Ship>>(List<Ship>())
	vec.push(mv Ship(42))

	ref Box<List<Ship>> vec_ref = vec
	const Ship elem = vec.at_or_panic(0)

	vec.push(mv Ship(73))

	vec_ref.push(mv Ship(81))
	Console.write_line("\{elem.fuel} \{vec.length}")
}
```

**5. The `push` signature** (`func push<T>(self &Vec<T> mut)` — mutability
as a function effect). List's actual signature — `ref self` is the `mut`
effect, `mv T` is ownership transferring in:

```nomen
pub func push = (ref self, mv T value) { ... }
```

**6. Single ownership** (`struct Engine { fuel int }`, `struct Ship {
engine Box<Engine> }`, `foo(&ships)`). The Ship owns its Engine through a
box, stored in a list; element reads are copies, so the cycle is fetch →
mutate → write back. Prints `Kestrel 50`:

```nomen
import System

mv struct Engine {
	var int fuel
}

mv struct Ship {
	var Box<Engine> engine
	var string name

	func refuel = (ref self, int amount) {
		self.engine.fuel = self.engine.fuel + amount
	}
}

pub func main = () {
	var ships = List<Ship>()
	ships.push(mv Ship(mv Box<Engine>(Engine(10)), "Kestrel"))

	var Ship ship = ships.at_or_panic(0)
	ship.refuel(40)
	ships.set_or_panic(0, mv ship)

	const Ship after = ships.at_or_panic(0)
	Console.write_line("\{after.name} \{after.engine.fuel}")
}
```

**7. `gem` — "somewhere inside the receiver"** (wildcard descendant paths).
A `view` accessor; the result re-roots at the receiver argument at the call
site, so no path spelling is needed. Prints `diamond`:

```nomen
import System

pub func main = () {
	const doc = "gem: diamond"
	const chest = Chest(doc.slice(5, 12))

	view string g = chest.gem()
	Console.write_line(g.to_string())
}

struct Chest {
	var view string gem_field

	func gem = (self, out view string) {
		return self.gem_field
	}
}
```

**8. The type-stability exception** (the appendix: `add_entity` mutates the
Level's maps; the `terrain` reference survives). Under copy semantics this
is structural: the terrain read is a copy of a value-type field, and
`add_entity`'s `ref self` mutation touches only the map. Prints `64`:

```nomen
import System

struct Terrain {
	var int tiles
}

mv struct Entity {
	var int id
}

mv struct Level {
	var Terrain terrain
	var Map<int, Entity> entities

	func add_entity = (ref self, mv Entity entity) {
		self.entities.set(entity.id, mv entity)
	}
}

pub func main = () {
	var level = Level(Terrain(64), Map<int, Entity>())

	const Terrain terrain_ref = level.terrain

	level.add_entity(mv Entity(1))

	Console.write_line("\{terrain_ref.tiles}")
}
```

The boundary of "for free" is the view-field case: a `ref self` method is
only as innocent as the sources of the views a caller still holds, and
today one mutated source poisons every view field of the struct (probe
above). Field-scoped invalidation (item 1 below) is what would narrow
exactly that.

**9. The RC blend preview** (`class World` — references without paths).
Nomen's spelling of that shape is deterministic: `WeakHandle<T>` for
back-pointers and observers, arena containers (flat `Buffer`s, single
owner, flat free) for graph shapes — see "No reference counting needed"
below. A shared mutable graph across tasks is spelled with `Mutex` /
`Channel` (SPEC.md, "Concurrency").

**10. Temporary uniqueness** (handing Valen references to Rust as `&mut`).
No Nomen analog: `foreign func` boundaries take plain values, and raw
`#arch` bodies don't carry a borrow calculus across (item 3 below).

## Concurrency

The classic objection to invalidation models: shared-xor-mutable isn't just
a restriction, it's what buys data-race freedom — and an invalidation
checker needs to know where every reference lives. A reference captured in
a closure, stored in a higher scope, or sent to another thread escapes the
checker's knowledge; without an answer, the model is confined to
straight-line code with second-class closures.

Valen's design answer: a function or scope declaring no `mut` effects is
effectively taking an immutable reference, so mut-free closures can be
shared across threads under structured concurrency; a `Mutex` applies a
mut-effect closure without itself being a `mut` effect; a future effect
kind may let partially-`mut` values cross threads. As specified today,
though, a `mut` effect anywhere in a group taints the whole value from a
thread-sharing perspective, permissions are blanket per group (there is no
"all other entities are readonly"), and there is no Send/Sync analog.

Nomen's design answer (SPEC.md, "Concurrency"; ASYNC.md, "Sharing data
between tasks"):

- **Nurseries bound the share.** `async { Thread(...).start() }` must
  rejoin before its lexical scope exits — the join is the borrow region.
- **The freeze is shared-xor-mutable for the shared window.** A borrowed
  root is const from the `async` block's construction to its closing
  brace — no writes, no move-out, no `ref self` calls. Nothing aliased by
  a running task can change while it runs.
- **`Sendable` is the Send analog.** What crosses is spelled at the call
  site: moved (exclusive — the caller gives up access), copied
  (independent), or borrowed (freeze-bounded). Trait handles cannot cross;
  `.detach()` rejects every shared capture (no join to bound them);
  process-lifetime globals are their own region proof.
- **`Mutex`/`Atomic` are the sanctioned escape** for genuine shared
  mutability — opt-in, never the default; the freeze deliberately exempts
  `Atomic`'s methods as the sanctioned mutation path.

The escape routes are closed by construction rather than by an effect
calculus: lambda captures are eager copies/moves ("every capture is an
eager argument"), borrows cannot be stored into fields or containers
(MEMORY.md, "Borrow Lifetimes"), and `ref` fields are rejected outright.

Honest residue, both sides: the freeze is whole-root — no per-field
precision — and neither language has a Rayon-style auto-parallelization
story (in Rust, shared^mutable proofs are what let a `Vec` parallelize for
free). If element-level parallel access is ever wanted, Nomen's
compile-time bounds contracts could extend to index-disjointness proofs
(`i != j`) — the same constraint machinery, one more relation.

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
   _Design constraint:_ effect- or path-shaped signatures leak
   representation — a field-path depends on the concrete implementation, so
   hiding fields behind accessors breaks "the paths a function modifies",
   and path clauses appear to require access to private fields. Three
   mitigations preserve abstraction: a conservative whole-owner fallback
   (the wildcard-path analog, already the plan), re-exporting an internal
   field group under a public name so an API has a stable effect name, and
   the immutability exemption (annotations are only ever needed for
   mutation — Nomen has this already: bare-`self` methods invalidate
   nothing). Nomen's root-name model is abstraction-proof — nothing
   path-shaped appears in any signature — and preserving that property is
   the constraint on how effect sets get exposed.
2. **Mutable-in-Immutable** (bigger lift, maybe later). A way to say "this
   function may mutate inside `world.entities[]` and nothing else" — a
   stronger API contract (nothing in the body can touch the rest of the
   world) and an optimizer hint (fine-grained may-write information). Valen
   gets it from path-typed parameters; a Nomen version would likely be a
   declared effect on the method, not a parameter type.
3. Not worth stealing: **wildcard descendant paths** (Nomen's re-root-at-
   `self` return convention for method borrows already approximates "points
   somewhere inside the receiver" — the same reasoning covers **path
   unions**, Valen's planned answer to conditionally-returned references; a
   Nomen return re-roots at the receiver, so there is no return-path to
   union), **temporary uniqueness** (that exists to bridge Rust's `&mut`;
   Nomen's raw `#arch` boundaries don't carry a borrow calculus across),
   and the **RC blending** (see below).

## Where Nomen differs by choice

- **Compile-time bounds contracts.** Group borrowing sidesteps indexing via
  references, but indexing still pays a runtime bounds check (the source of
  most of Valen's Rust-contrast examples). Nomen proves most indices in
  bounds at compile time — parameter constraints on accessors
  (`at(index: index >= 0 && index < self.length)`) discharged by
  flow-sensitive analysis over loop ranges, conditions, and return
  contracts, with unprovable indices rejected outright (MEMORY.md,
  "Compile-time bounds checking"). Orthogonal to borrowing; complementary
  to Valen's mechanism.
- **No reference counting needed.** Valen's roadmap blends in RC to handle
  graphs, observers, and back-pointers. Nomen covers those
  deterministically: `WeakHandle<T>` — a generational (pointer, generation)
  slot table, the Vale-style runtime mechanism — for the cyclic/back-pointer
  cases, and arena containers for graph shapes. The two halves of the
  "compile-time generational reference" idea usually live in different
  languages; Nomen has both — the compile-time half (invalidation) and the
  runtime half (`WeakHandle`) — without GC or RC.
- **Deferred reclamation.** Same-scope owner reassignment frees the old
  instance at scope exit rather than eagerly, so in-scope borrows stay
  valid (MEMORY.md, "Borrow Lifetimes"). Valen invalidates eagerly here.
  The philosophies are opposite: Nomen biases toward "don't free while
  borrowed" (cost: peak memory), Valen toward "invalidate precisely, free
  eagerly" (cost: false positives without path precision). Both are sound;
  worth naming because it explains why the same program can be accepted by
  one and rejected by the other.
- **Enum payload safety by construction.** The tagged-union hazard Valen's
  type-stability machinery exists to manage — invalidate interior
  references when an enum changes variant — cannot arise in Nomen: no
  interior reference into an enum payload can be created (MEMORY.md,
  "Tagged-union type confusion").

## Shortfalls

- **Mutate-one-part-while-borrowing-another** (the `step` case): Nomen
  handles the read-only callee case cleanly but re-fetches under mutual
  mutation. Field-scoped invalidation (item 1 above) narrows this; full
  Mutable-in-Immutable would close it.
- **View-field poisoning.** One mutated source poisons every view field of
  a struct (probe above) — the remaining coarseness behind item 1.
- **Many structs referencing a common subsystem** (the `File` →
  `FileSystem` shape, zero-cost in group borrowing): Nomen rejects `ref`
  fields outright (a non-mv borrow field could outlive its target), so the
  shape costs a `WeakHandle` slot lookup at runtime or a restructure.
- **Containers of view-carrying structs** are not lifetime-checked against
  their borrow sources (documented limitation, MEMORY.md "Struct Layout");
  Valen's paths would cover this uniformly.
- **Exclusivity is only expressible via `mv`.** Valen keeps
  shared-xor-mutable _sayable_ (unique = the only reference into a group
  carrying a `mut` effect; shared = references with no `mut` effects;
  aliasing opt-in via `in`). Nomen's aliases are unconditional — there is
  no way to state "this is the only reference" — which matters for
  optimizer noalias hints and any future data-parallel story. The async
  freeze recovers exclusivity, but only inside nurseries.

## Pointers

- Checker machinery: `src/check/utils/borrow.ts` (`borrow_depth_of`,
  `borrow_owner_of`, `receiver_owner_of`, `invalidate_borrows_of`,
  `invalidate_view_borrows_of`, `persist_invalidated`); invalidation call
  site `src/check/check_access_node.ts` (the `ref self` arm).
- Memory model: [MEMORY.md](./MEMORY.md) — "Borrow Lifetimes",
  "Compile-time bounds checking", `WeakHandle`, "Tagged-union type
  confusion".
- Concurrency: SPEC.md, "Concurrency" (`Sendable`, the freeze, `Mutex`,
  `Atomic`, `Channel`, `WeakHandle`); [ASYNC.md](./ASYNC.md), "Sharing data
  between tasks".
- Follow-up sketch: FOLLOWUP.md, "Field-scoped borrow invalidation
  (Valen-style effect precision)".
