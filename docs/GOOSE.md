# Nomen vs Goose

A review of [Goose](https://aardappel.github.io/goose/)
([repo](https://github.com/aardappel/goose)) — Wouter van Oortmerssen's
memory-safe systems language with no heap allocator — and what in it is worth
adopting into Nomen. This records the Oct 2026 analysis so it isn't lost;
individual features, if pursued, should graduate into their own docs
([BORROW.md](BORROW.md), [ASYNC.md](ASYNC.md), [ARRAY.md](ARRAY.md)) the way
the other plans did.

Goose compiles to one C file (plus an in-process TinyCC backend), frees all
memory at scope exit, and needs no GC, no reference counting, and no lifetime
annotations. Its benchmark suite claims 3.3–3.5x idiomatic C++, ~1.2x
hand-optimized C++, and ~1.15x best safe Rust, with less memory. The gains
come from data layout and the memory model, not from an optimizer.

## The two models in one paragraph

Goose answers "safety without a GC" with a **memory-model trick**: a program
has N bump-pointer data stacks, at most one resizable value is live per stack
and it is always on top, so growth never moves memory and freeing a whole
structure is one store. Every reference has a compiler-inferred static _root_;
a reference may not outlive its root. Nomen answers the same question with
**ownership tracking on a normal heap**: `mv`/`view`/`ref`, `Box<T>`, scope-exit
frees (see [MEMORY.md](MEMORY.md)). Goose's trick is elegant, but it is bought
with real restrictions: recursive functions cannot keep growable data across a
recursive call, only whole-program compilation, no escaping closures and no
function pointers. Nomen's model is strictly more general, and it is built —
the wholesale swap is not on the table. What follows is what's worth taking
_a la carte_.

Shared DNA already in place (for orientation): scope-exit cleanup, no GC;
`view T` ≈ `T[:]` slices; fat strings; int-indexed arena containers;
monomorphized generics; a C backend; an audit runtime.

## Inspiration list, ranked

### 1. Bounds-check transparency: `--bce-lines` and `checkfree fn`

Goose reports which bounds checks survive per source line, and `checkfree fn`
rejects a kernel if any check remains. Nomen's bounds story is compile-time
(parameter constraints verified by flow-sensitive analysis — unprovable access
is a compile error), with `.at_or_panic(i)` as the runtime-checked escape
hatch. That makes the analogs nearly free:

- a report mode (CLI flag) listing every `.at_or_panic` / reachable `panic`
  path, per line;
- a function-level annotation asserting the body contains none — checked by
  walking the built body, exactly like the existing constraint verification.

This turns the bounds story from "enforced" into "auditable", matching audit
mode's philosophy ([MEMORY.md](MEMORY.md), Audit Mode). Cheapest item on the
list; pure tooling.

### 2. Stable grow-only arrays: `T[>..]`

Growth is a pointer bump; memory never moves; a reference into the array stays
valid across a million pushes; `push` returns a reference to the new element
so structures can be linked while being built. Nomen's `List<T>` reallocs
(retiring its backing buffer), and a borrow into it is invalidated by
mutation — which forces the keep-a-parallel-index-array workaround.

Note this is **not** covered by `Arena<T>` (core/System/Arena.nm): the arena is
slot-based with generation-checked `ArenaRef<T>` _handles that copy freely_,
while Goose's array is packed with _borrows_ into it that survive growth. Both
are useful; they answer different questions.

The Nomen-shaped version: a `StableList<T>` stdlib container (next to
`List<T>` in core/System) whose storage is a chained or reserved arena that
never relocates live elements, plus one new borrow rule — a borrow of an
element is rooted at the _array_, and growth provably cannot move the element.
`push` returning a borrow to the new slot composes with the existing
borrow-lifetime check ([BORROW.md](BORROW.md)). The checker change is one new
rooting rule; everything else is stdlib.

Concrete first users (Oct 2026): `JsonTree`
(core/System/Text/JsonTree.nm) hand-rolls this shape today — a
`Buffer<JsonNode>` slab with untyped `int` links (`child`/`next`/`val`, −1 =
none) and the 56-byte element layout hand-encoded in `unsafe` blocks
(`idx * 7 + 2`), plus a manual strdup/`free_text`/`reset` lifecycle for slot
texts because the safe machinery would auto-free a slab-owned pointer. A
stable pool with owned slots deletes the unsafe slab arithmetic and the text
dance. `binarytrees` / `merkletrees` (bench/nomen) malloc+free one `Box` per
node — an arena variant with narrow index links is the Goose-style
comparison (their suite runs both forms), added as a labeled variant rather
than replacing the allocator-honest original.

**Shipped (Oct 2026, v2 — chunked):** `StableList<T>`
(core/System/StableList.nm) — chunk-0 `items` allocated once at exactly 256
slots, chunks 1.. as raw slab pointers in a `chunks` directory; `push`
exempted from borrow invalidation (`push_keeps_element_borrows` in
src/check/check_access_node.ts; the only such exemption besides Atomic's
frozen-root carve-out). Because no slab is ever resized, even interior slot
ADDRESSES are stable: `ref T x = sl.at(i)` lowers to `slot_ptr`, the alias
survives any number of pushes, and writes through it land in the list (the
Goose `first.weight = 99.5` demo works; test/stable-list.test.ts pins it).
`for of` iterates elements like List. The list is append-only (no
`pop`/`set`/`remove_at`) — displacing an element would invalidate its
borrows. The directory-tail store/load/destroy are raw bodies and unsafe
Nomen delegating to Buffer's mono'd methods (`load_from` bitwise-borrow,
`T_buffer_destroy` on a cap=filled view); the checker-side exemption and
both backends' pure-borrow destroy suppression carry the semantics. The
JsonTree replacement (the marquee use) rides on this directly.

### 3. `return E from f` — statically checked multi-frame error return

```goose
guard comma >= 0 else { return [], str("expected name,age: ", line) from load; }
```

Returns `E` as the result of the innermost active call of `f`, any number of
frames up. Every intermediate function keeps its plain signature — no
`Result`, no `?`, no unwinder; implemented as a hidden per-frame discriminant.
Crucially it is checked _statically_: every call chain reaching the construct
must provably lie inside an active `f` call, so nothing can go uncaught at
runtime.

Nomen's only error mechanism today is `panic` (process-fatal). This is the
missing middle for parsers and loaders — and Nomen's own compiler is a parser.
It is also a concrete candidate answer to ASYNC.md's open question
("Error propagation model. Should nursery failures panic, return a `Result`,
or both?"). The static reachability check is the part that makes it safe to
adopt; skip anything dynamic.

### 4. The in-place construction guarantee

`items.push(parse(line))` writes the parsed record _directly into the new
slot_, through any depth of calls — the destination is passed down, so there
is no temporary and no copy. Returning a growable array by value writes its
elements straight into the caller's variable.

Nomen builds fat strings and inline mv structs in temporaries and copies them
into container slots at the store. Destination-passing for container stores
(and for returns of growable containers) removes a real class of copies in hot
paths. This is codegen-level work in both backends, so it ranks below the
checker-level items, but the payoff shows up in every benchmark that builds
large structures.

### 5. Contained task failure: `thread_spawn_contained`

A worker whose check failure or `panic` delivers its message _to the waiter as
a value_ instead of killing the process — the supervisor logs it and respawns.
Goose's shape: `thread_wait(id, msg)` takes the message on first wait; a
worker compiled as its own program means containment is trivial.

Nomen's `Task<T>` already tears down the task stack on panic
([ASYNC.md](ASYNC.md)); the steal is the delivery channel — a
spawn-contained variant whose panic lands on the result slot as an error
string the waiter can `mv` out, plus the supervisor respawn idiom. Small,
natural extension of the existing task machinery.

### 6. Variable-mode enums: `Shape..`

Every ADT can be stored in two ways, chosen at the point of use: fixed mode
(tag + room for the largest payload) or _variable mode_, where each value
occupies exactly its variant's size — 9/17/1 bytes instead of 17 each. An
array of them is packed and sequential; 4x less memory than a Rust `enum` on
Goose's benchmark for it. Very relevant to Nomen's own token/AST-shaped
workloads.

The constraint that makes it safe in Goose: a variable-mode value can **never
change variant**, which is why references into payloads are allowed. That is
exactly the condition Nomen's current soundness argument leans on — MEMORY.md's
tagged-union note is safe _because_ no interior reference into an enum payload
can come into existence. So a packed enum in Nomen must be frozen at
construction (no overwrite-in-place), and payload references stay forbidden
until an enum-aware invalidation pass exists.

### 7. Narrow, position-independent handles + verified byte images

A Goose `T&<u32>?` is a typed, nullable link stored as a 1/2/4-byte offset
(self-relative, or relative to a named pool). Structures built from them are
position-independent: `to_bytes` is one write, `from_bytes` is one read plus a
verification pass (every tag, length, and link checked) that rejects corrupt
or hostile input as a value, never a wild reference.

Nomen already has the _typed handle_ half: `ArenaRef<T>` is `{ index,
generation }`, and a stale handle is detected rather than silent. The steal is
the other half:

- a **narrow encoding** (u16/u32 offsets relative to the arena base) so
  handle-heavy structures stop paying 16 bytes per link;
- **verified serialization**: dump an arena-structured whole to bytes and load
  it back through a checker — no schema, no pointer fixups, hostile-input
  safe.

The natural home is the audit runtime's C side plus an `Arena` method pair.
Useful for any file-format story and for the extension.

### 8. TinyCC in-process backend

Goose bundles libtcc so `goose file.goose` compiles and runs the generated C
inside the compiler's process — no build step. Nomen already emits C, so
wiring tcc into the extension's Run/Audit loop would make the edit-run cycle
near-instant compared to a full aarch64 assemble + link. Caveat from Goose's
own docs: tcc cannot place thread-local storage, so anything using the task
runtime needs the real build path — same split Goose draws (`run` in-process,
`build` for threads).

## Not worth stealing

- **The no-heap data-stack model wholesale.** Elegant, and the source of most
  of Goose's numbers, but the restrictions (recursion vs. growable scratch,
  whole-program only, no closures) are structural. Nomen's heap + ownership is
  the more general point in the design space. The _bounded_ version worth
  having someday: a bump-allocated scratch arena for per-scope temporaries,
  if cheap allocation ever matters without touching ownership machinery.
- **The no-move philosophy.** Goose has no moves (moving a resizable value is
  even listed as future work) because the memory model makes them mostly
  unnecessary. Nomen's `mv`/`swap`/`.copy()` is more expressive; keep it.
- **`reusable` pool stale reads.** Goose's pool `free` leaves freed slots
  reading "a different value of the correct type" — a documented logic bug,
  never corruption. Nomen's `Arena<T>` generation bumps _detect_ the same
  mistake (`get` panics, `is_valid` tests it). Nomen's version is the better
  design; nothing to take.

## Docs culture worth copying

- **Errors that cite the spec.** Goose's lifetime error ends with the spec
  section: "(§9.2)". Nomen's `test/spec/` is already keyed to SPEC.md
  sections; having compiler errors reference the section closes the loop and
  makes the spec load-bearing.
- **Benchmark honesty.** Goose publishes whole-process wall-clock including
  teardown, a design doc for what the suite tests, and an explicit "cases
  where Goose loses" section. The losing section is what makes the winning
  numbers credible — worth mirroring in `bench/` alongside
  [PERF.md](PERF.md)'s measured-numbers discipline.
- **Per-feature Limitations lists** in the tutorial and spec, and pass-by-pass
  implementation notes. MEMORY.md already does much of this; the
  pass-by-pass format is a good template for future subsystem docs.

## If you only do two

1. **Bounds transparency** (#1) — a weekend, pure tooling, makes an existing
   strength auditable.
2. **Stable grow-only arrays** (#2) — the one that changes what Nomen
   programs can express: borrow-rooted-at-a-non-moving-container is one new
   checker rule plus a stdlib container.
