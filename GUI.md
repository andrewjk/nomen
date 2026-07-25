# Layout & Compositor

A layout engine and compositor for the Nomen `core/System/Controls` UI layer.

## Overview

Every UI is a **tree of controls**. Layout is a conversation between parent and
child — constraints flow **down** (the parent tells each child how much space is
available), and intrinsic sizes flow **up** (each child reports how much space it
actually wants). The engine resolves this into concrete pixel rectangles, then a
second pass assigns positions.

```
Window (800×600)
└── VStack (padding=16, spacing=8)
    ├── Text("Title")          ← intrinsic: 160×16
    ├── HStack (spacing=12)
    │   ├── Image(logo.png)    ← intrinsic: 64×64
    │   └── Text("Body text…") ← intrinsic: wraps to fit available width
    └── Button("OK")           ← intrinsic: 60×32, grow=1 (fills remaining)
```

## Implemented: handle-based container (v1)

`core/System/Controls/Container.nm` ships a working, ergonomic layout layer
**today**. The full `Control`-trait design below is the target, but it depends on
compiler work that isn't done yet (see [Next steps](#next-steps--compiler-prerequisites)),
so v1 is **handle-based** rather than trait-based.

```
import System
import System/Controls

pub func main = () {
	var Window win = Window("Nomen Todo", 400, 500)
	var Text title = Text(win)
	var CheckBox cb0 = CheckBox(win)
	var TextBox input = TextBox(win)
	var Button add_btn = Button(win, "Add")

	// Add child controls to a 2-column grid; no coordinates, no y-flipping.
	var Container grid = Grid(2, 8)
	grid.padding = 16
	grid.add(title.handle, 0, 30, 2)     // span 2 → full-width row
	grid.add(cb0.handle, 0, 24, 2)
	grid.add(input.handle, 0, 24, 1)     // col 0 of last row
	grid.add(add_btn.handle, 0, 32, 1)   // col 1 of last row
	grid.layout(win)                      // measure + arrange + apply (flips y)

	if grid.contains(add_btn.handle, win.click_x(), win.click_y()) { ... }
}
```

What `Container` provides:

- **`Grid(cols, spacing)` / `VStack(spacing)` / `HStack(spacing)` / `ZStack()`** factory
  functions returning a `Container`.
- **`add(handle, w, h, span)`** — append a leaf control by its native handle.
  `w`/`h` of `0` mean "fill" on that axis; `span` is the grid column count
  (use `1` for stacks).
- **`add_to(parent, handle, w, h, span)`** — append a leaf under an explicit
  parent node (returned by one of the `add_*` container helpers below).
- **`add_vstack/add_hstack(parent, spacing, span)` / `add_grid(parent, cols, spacing, span)` /
  `add_zstack(parent, span)`** — append a **nested** container under `parent`,
  returning the new node's index so children can be added to it. `root_index()`
  yields the top-level parent. This makes the tree composable without the trait
  model — the SoA `kinds` buffer is the tag, and `measure`/`arrange` already
  recurse through `first_child`/`next_sibling`.
- **`layout(win)`** — measures against the window's content rect (minus
  `padding`), arranges, and applies frames to every leaf, **flipping y against
  the content height internally** so callers never do coordinate math.
- **`contains(handle, cx, cy)`** — top-left-origin hit test (matches
  `click_x`/`click_y`).
- **`compute(w, h)`** + **`fmt_frame(i)`** — pure-math entry points for
  headless geometry tests (no native calls).
- **Hidden controls are skipped automatically** — a leaf whose native view
  `isHidden` takes no space, so toggling visibility and re-laying-out just works.

Children flow left→right, top→bottom; a child whose `span` won't fit in the
remaining columns wraps to the next row. `ZStack` overlaps its children (each
gets the stack's full frame; the stack sizes to its largest child). Geometry is
validated by `test/layout_container.test.ts` (vstack, hstack, zstack, grid
span/row/mixed, and nested stacks/grids).

### Why handle-based, not trait-based (for now)

Every native control is `class { uint64 handle }`, and the y-flip needs the
window's content height — both are handle-level concerns. But the decisive
reason is the compiler: the `Container : Control` / `Array<Control>` design
below requires things the compiler does **not** all do yet —

1. ~~**aarch64 has no vtable dispatch**~~ ✅ **Done.** Both backends now generate
   a per-struct trait vtable and resolve trait-typed calls through it at
   runtime (see [Trait dispatch](#trait-dispatch-polymorphic-calls)). The
   remaining blockers are storage/parsing, below.
2. ~~**No heterogeneous container storage**~~ ✅ **Done.** `monomorphize`
   routes trait-`T` to `ClassBuffer`, the per-element destroy dispatches
   through the trait vtable, and the native controls are `class`es (reference
   types) so they slot straight into `ClassBuffer<Control>` without any
   boxing — see [Next steps](#next-steps--compiler-prerequisites)). (Value
   structs can no longer be implicitly boxed into trait-typed slots; they
   must be declared `class` to be used polymorphically.)
3. ~~**Trait conformance with type arguments isn't parsed yet**
   (`core/System/Viewable.nm:8`).~~ ✅ **Done.** `trait Foo<T>` declarations and
   `struct C: Foo<ConcreteType>` conformance now parse, arity-check, and build
   on both backends — see [Next steps](#next-steps--compiler-prerequisites).

So v1 stores child handles in flat `Buffer<int>` arrays (structure-of-arrays,
mirroring the legacy `Layout.nm`) and applies frames via a native
`apply_frame(handle, …)` helper. The measure/arrange **algorithm** is identical
to what the trait version will use, so migrating later only swaps the
storage/dispatch shim, not the math.

> Note: `Container.nm` lives in trusted core, so its runtime-indexed
> `Buffer.load_int`/`store_int` calls do not trip the "constraint cannot be
> verified" rule (`check_function_call.ts:585`) that broke the old
> index-juggling app code.

## Core principles

1. **Constraints down, sizes up.** A parent hands each child a `BoxConstraints`
   (min/max for both axes). The child hands back a `Size`. This is the measure
   phase.
2. **Frames down.** Once the root size is known, the engine walks top-down and
   assigns each node a concrete `Frame` (x, y, width, height). This is the
   arrange phase.
3. **Intrinsic sizes are queries.** Any control can be asked "given unbounded
   space, what's your natural size?" — an image reports its pixel dimensions, a
   text reports its unwrapped length, a container reports the tightest fit of its
   children. This lets parents make decisions ("this text is too wide, wrap it").
4. **Layout params live on the edge.** `grow`, `shrink`, `width: .percent(50)`,
   `align: .center` are properties of **how a child sits in its parent**, declared
   when the child is added. A leaf control has no opinion about how it should
   flex; the parent does.
5. **The control tree is the layout tree.** No separate layout-node graph.
   Containers are themselves controls whose `measure` calls `measure` on children.
   Parent-to-child only — no back-pointers, no cycles.
6. **Incremental relayout.** When a control's content changes (text updated,
   image loaded), it marks itself dirty. The engine propagates the mark upward
   (via `parent_of` on our arena-backed tree), remeasures only the dirty subtree,
   and rearranges only the affected branch.

## Data types

```
// ── Geometry ──

pub struct Size {
    pub var int width = 0
    pub var int height = 0
}

pub struct Frame {
    pub var int x = 0
    pub var int y = 0
    pub var int width = 0
    pub var int height = 0
}

pub struct Insets {
    pub var int top = 0
    pub var int right = 0
    pub var int bottom = 0
    pub var int left = 0
}

// ── Constraints (flow DOWN) ──

const int INFINITY = 2147483647

pub struct BoxConstraints {
    pub var int min_width = 0
    pub var int min_height = 0
    pub var int max_width = INFINITY
    pub var int max_height = INFINITY

    pub func tighten_width = (self, int min, int max, out BoxConstraints) {
        var BoxConstraints c = self
        c.min_width = self.min_width
        if min > c.min_width { c.min_width = min }
        c.max_width = self.max_width
        if max < c.max_width { c.max_width = max }
        return c
    }
    pub func tighten_height = (self, int min, int max, out BoxConstraints) { /* mirror */ }

    pub func clamp_width = (self, int value, out int) {
        if value < self.min_width { return self.min_width }
        if value > self.max_width { return self.max_width }
        return value
    }
    pub func clamp_height = (self, int value, out int) { /* mirror */ }

    pub func is_width_bounded = (self, out bool) { return self.max_width < INFINITY }
    pub func is_height_bounded = (self, out bool) { return self.max_height < INFINITY }
}

// ── Requested size (user-facing, on LayoutParams) ──

pub enum LayoutLength {
    case auto                     // size to content (intrinsic measurement)
    case fixed(int pixels)        // exact size
    case percent(int numerator)   // numerator/100 of available space (e.g. 50 = 50%)
    case fill                     // fill all available space (same as grow=1)
}

pub enum Alignment {
    case start
    case center
    case end
    case stretch
}

// ── Per-child layout parameters ──

pub struct LayoutParams {
    pub var LayoutLength width = .auto
    pub var LayoutLength height = .auto
    pub var int grow = 0           // flex weight for distributing surplus space
    pub var int shrink = 0         // flex weight for distributing deficit
    pub var Alignment align_self = .stretch   // cross-axis alignment override
}

// Sensible defaults so most children just work
const LayoutParams DEFAULT_PARAMS = [ width = .auto, height = .auto, grow = 0, shrink = 1, align_self = .stretch ]
```

## The Control trait

```
pub trait Control {
    // Given these constraints, report the size you want to be.
    // Must satisfy min_width ≤ result.width ≤ max_width (ditto height).
    func measure = (self, BoxConstraints constraints, out Size)

    // Apply a concrete rectangle. For native controls this calls setFrame:
    // on the platform handle. For containers this also arranges children.
    func set_frame = (ref self, int x, int y, int width, int height)

    // What size would you be with unbounded space? (Used by parents to
    // decide wrapping, scrolling, etc. Default: call measure with infinity.)
    func intrinsic_size = (self, out Size)
}
```

## The algorithm

### Measure phase (constraints down, sizes up)

```
func measure_subtree = (Control node, BoxConstraints c, out Size) {
    return node.measure(c)
}
```

A container's `measure`:

1. Compute child constraints by tightening the parent's constraints according
   to the container's own rules (subtract padding, enforce stack-axis limits).
2. For each child, resolve `LayoutParams.width` / `.height` against the available
   space:
   - `.auto` → pass through the available constraints (child picks its size)
   - `.fixed(n)` → clamp to exactly n
   - `.percent(p)` → `available * p / 100`, clamped
   - `.fill` → set both min and max to the full available size
3. Call `child.measure(child_constraints)` for each child.
4. Combine child sizes: sum along the main axis, max along the cross axis.
5. Apply the container's own insets (padding).
6. Clamp to incoming constraints and return.

### Arrange phase (frames down)

```
func arrange = (Control node, Frame f) {
    node.set_frame(f.x, f.y, f.width, f.height)
}
```

A container's `set_frame`:

1. Store own frame.
2. Compute the content rect: own frame minus insets.
3. Walk children, distributing space:
   - Start with each child's measured size.
   - If total < content and children have `grow > 0`: distribute the surplus
     weighted by `grow`.
   - If total > content and children have `shrink > 0`: distribute the deficit
     weighted by `shrink`.
4. For each child, compute its cross-axis position from `align_self` (or the
   container's default alignment), and its main-axis position from the running
   offset plus spacing.
5. Call `child.set_frame(child_x, child_y, child_w, child_h)`.

### Width-affects-height (text wrapping)

Under the 8px/char, no-wrapping assumption, a single measure pass suffices.
When wrapping is added, containers whose children's height depends on their
width do a two-step measure:

1. Measure with unbounded height to get the "natural" height at the available
   width.
2. If the natural height exceeds the max-height constraint, remeasure with a
   tighter width (binary-search or fixed-step).

The `BoxConstraints` / `Size` model handles this naturally — only the leaf
`Text.measure` changes. Containers just pass constraints through and read sizes
back.

## Per-container rules

### Block

A single-child rect with optional padding. `measure`: passes constraints minus
insets to the child, returns child size plus insets (or a fixed/percent size
from its own params). `set_frame`: forwards content rect to child.

### VStack (vertical stack)

Main axis = vertical, cross axis = horizontal.

- **Measure**: each child gets the parent's width constraints (minus padding) and
  unbounded height. Sum child heights, add `spacing × (n-1)`. Width = max child
  width. Clamp.
- **Arrange**: children top-to-bottom. Surplus height distributed by `grow`.
  Cross-axis position from alignment.

### HStack (horizontal stack)

Mirror of VStack. Main axis = horizontal.

### ZStack (overlap)

Children stack on top of each other (like CSS z-index).

- **Measure**: width = max child width, height = max child height.
- **Arrange**: every child gets the full frame (minus alignment offset).

### Grid

Fixed column count `cols`.

- **Measure**: column width = `max_width / cols`. Each child measured with its
  column width and unbounded height. Row height = max child height in that row.
  Total = sum of row heights + gaps.
- **Arrange**: child `i` → row `i / cols`, col `i % cols`. Position at
  `(x + col × col_width, y + cumulative_row_height)`.

## Invalidation & incremental relayout

Each control has a `dirty` flag and a reference to its parent (via `parent_of`
on the arena tree, or a `parent` field on class-based controls).

```
func mark_dirty = (ref Control node) {
    // Walk up the tree, marking ancestors dirty
    var int idx = node.id
    while idx != -1 {
        var Control n = tree.at(idx)
        n.dirty = true
        idx = tree.parent_of(idx)
    }
}
```

On relayout:

1. Start from the root (or the lowest dirty ancestor).
2. Remeasure the dirty subtree only.
3. If the subtree's size changed, mark the parent dirty and repeat.
4. Once sizes stabilise, walk the dirty branches and re-arrange.

This keeps relayout O(dirty subtree) instead of O(full tree) for common cases
(text change, image load, toggle visibility).

## Compositor

The compositor sits above the layout engine and manages the rendering pipeline:

```
┌──────────────────────────────────────────────────┐
│  Compositor                                      │
│  1. Layout: measure + arrange → tree of Frames   │
│  2. Render: walk frames, draw each control       │
│  3. Hit test: given (x,y), find the frontmost     │
│     control whose Frame contains the point        │
│  4. Animate: interpolate frames between states    │
│  5. Dirty tracking: only re-layout/repaint what   │
│     changed                                      │
└──────────────────────────────────────────────────┘
```

### Render order

ZStack children paint back-to-front. Other containers paint in child order.
The compositor maintains a dirty-rect list; only dirty regions are repainted.

### Hit testing

Given a touch/click at `(px, py)`, walk the frame tree front-to-back:

1. If `px` is outside the control's frame, skip.
2. For containers, test children in reverse order (frontmost first).
3. If a child claims the hit, stop.
4. If no child claims it, this control claims it.

This needs no platform code — it's pure rect math on the Frame tree.

### Animation

An animatable property (position, size, opacity) has a current value and a
target value. Each frame, the compositor interpolates: `current += (target -
current) × easing`. Layout runs against the interpolated values, producing
smooth transitions without the layout engine knowing about animation.

## Native control refactor (groundwork)

`Window` and `Text` must conform to `Control`:

- **Window**: already takes width/height at creation. Add `measure` (returns the
  content size), `set_frame` (calls `setFrame:` on the NSWindow/UIWindow handle),
  and expose the content-view handle so containers can add subviews.
- **Text**: decouple creation from framing. Don't hardcode `(10, 10, 200, 30)`.
  Default frame `0,0,0,0`; let layout drive it. Add `measure` returning
  `Size(text.length × 8, 8)` (v1 8px monospace assumption). Add `set_frame`
  calling `setFrame:` on the NSTextField/UILabel handle. Accept a parent-view
  handle so it can be added to any container view, not just the window's content
  view.
- Set a monospace font on `Text` so the 8px assumption is approximately honest.

## Container base

```
pub struct Container : Control {
    pub var Array<Control> children = Array<Control>()
    pub var Array<LayoutParams> params = Array<LayoutParams>()
    pub var Insets padding = Insets()
    pub var int spacing = 0
    pub var Alignment align = .start     // default cross-axis alignment for children

    pub func add = (ref self, Control child) {
        self.children = self.children.add(child)
        self.params = self.params.add(DEFAULT_PARAMS)
    }

    pub func add = (ref self, Control child, LayoutParams p) {
        self.children = self.children.add(child)
        self.params = self.params.add(p)
    }
}
```

`Container` should be a `class` (reference type) so children mutate in place
during arrange without copies. Parent → child references only — no parent
back-pointers — to avoid reference cycles.

## Testing strategy

The test harness compiles to aarch64 and asserts on stdout. GUI rendering
cannot be verified headlessly, but the **layout math** can:

1. **Pure-math tests** (bulk). Build a tree, run layout with known constraints,
   print the resulting child frames (`x,y,w,h` via `Console.write`), compare
   against hand-computed values. Cover: each container in isolation, nesting,
   grow/shrink, percent sizing, min/max clamping, padding/spacing, alignment,
   Grid row/col math.
2. **Trait smoke test.** Verify `Array<Control>` stores heterogeneous controls
   and dispatches `measure` correctly.
3. **Native controls.** Build + link only. Verify rendering manually on macOS.

## Implementation phases

1. **Smoke test.** ✅ Skipped the trait route — `Container.nm` ships a
   handle-based v1 instead (see above). Trait smoke test is deferred to phase 9.
   **Trait polymorphic dispatch now works on both backends** (C + aarch64) and
   is runtime-tested in `test/trait_dispatch.test.ts` — see
   [Trait dispatch](#trait-dispatch-polymorphic-calls).
2. **Geometry types.** ⚠️ Deferred. v1 uses raw `int` width/height + the
   `Container`'s flat buffers; the `Size`/`Frame`/`Insets`/`BoxConstraints`/
   `LayoutLength`/`LayoutParams` types are part of the trait migration.
   Implementing them as specified is currently blocked by compiler gaps — see
   [Geometry types (Phase 2) blockers](#geometry-types-phase-2-blockers).
3. **Block + Spacer leaf.** ⚠️ Deferred (needs the trait model).
4. **VStack then HStack.** ✅ Implemented handle-based, with padding/spacing and
   fill semantics (no grow/shrink/percent/alignment yet).
5. **ZStack, then Grid.** ✅ Grid done (flow + column `span`); ZStack done
   (children overlap, each gets the stack's full frame, stack sizes to its
   largest child). Nested containers (VStack/HStack/Grid/ZStack inside any
   other) are also done via the `add_*` helpers — the SoA `kinds` buffer is the
   tag, so `measure`/`arrange` recurse through the tree without the trait model.
6. **Refactor Window/Text** to conform to `Control`. ⚠️ Partial: `Window` gained
   `content_width`; controls still expose `handle` for the handle-based API.
   Wiring native `setFrame:` is done inside `Container.apply_frame`.
7. **End-to-end sample.** ✅ `app/src/main.nm` (the todo app) builds and runs on
   **both** the C/macOS and aarch64 backends using a 2-column `Grid`. (The
   aarch64 path had been silently broken by a >8-param function overflowing the
   register-arg ABI — see
   [Smaller compiler bugs](#smaller-compiler-bugs-hit-while-building-v1); fixed
   by keeping `Container`'s helpers at ≤8 register params.)
8. **Invalidation.** ⚠️ Deferred. v1 does a full re-measure on every
   `layout(win)` call (cheap for small UIs; fine for the todo app).
9. **Compositor features.** ⚠️ Deferred (hit testing, dirty-rect, animation).

## Next steps & compiler prerequisites

To move from the handle-based v1 toward the full `Control`-trait design below,
the compiler needs these (tracked here, not in `SPEC.md`, since they're pre-spec
UI infrastructure):

### Trait system gaps (unblock `Array<Control>` polymorphism)

- ~~**aarch64 vtable dispatch.** Generate per-struct trait function-pointer
  tables and a `_get_trait_func(obj, trait, func)` resolver, mirroring the C
  backend.~~ ✅ **Done** on both backends — see
  [Trait dispatch (polymorphic calls)](#trait-dispatch-polymorphic-calls).
- ~~**`monomorphize` routes trait-`T` to `ClassBuffer`.**~~ ✅ **Done.**
  `check_function_call_node.ts:183-209` now recognizes a `Buffer<Elem>` field
  whose `Elem` is a trait (not just a class) and rewrites both the field type
  and its default constructor to the monomorphized `ClassBuffer_<Trait>` so
  every build path resolves against the concrete buffer. Runtime-tested on
  both backends in `test/trait_collection_destroy.test.ts` (homogeneous and
  heterogeneous `List<Speaker>`).
- ~~**Trait-typed destroy propagation in containers.**~~ ✅ **Done.**
  `ClassBuffer<Trait>#destroy` walks each slot and dispatches `<Trait>_destroy`
  through the vtable (`core/System/ClassBuffer.nm:179-225`), with the
  vtable-shim symbols synthesized in `src/build.ts:75-103` (aarch64) and
  `src/build_c/build_root_node.ts:97-121` (C). Verified end-to-end on both
  backends by `test/trait_collection_destroy.test.ts`.
- **Value structs are not boxed into trait-typed slots — use a class.**
  Trait-typed parameters and `ClassBuffer<Trait>` slots hold heap-allocated,
  vtable-bearing pointers. A value `struct : Trait` can't meet that without
  an implicit heap allocation ("boxing") at the call site — the one place the
  language hid an allocation — so boxing has been **removed**. Passing a value
  struct to a trait-typed parameter now errors (`value struct 'X' cannot be
used as trait 'T'; declare 'X' as a class`). The native controls are
  `class`es, so they slot straight into `ClassBuffer<Control>` with no boxing.
  (Trait-typed _locals_ with concrete struct storage — `var Speaker s = Dog()`
  — still work; they keep the struct on the stack and dispatch through its
  vtable, so there's no hidden allocation.) The `is_boxed` declaration flag,
  the `build_boxed_declaration` helpers, and the boxed-var branch in
  `build_auto_free` are all gone.
- ~~**Parse trait conformance with type arguments** (`core/System/Viewable.nm:8-11`,
  not `Controls/Viewable.nm`), so `Container<T: Control>`-style generics
  become possible. `TraitNode` has no `type_params` field, `parse_trait.ts`
  doesn't accept `<...>` after the trait name, and `parse_struct.ts:36-40`
  parses trait conformance as a bare name only.~~ ✅ **Done.**
  - `TraitNode` gained a `type_params: string[]` field (`src/nodes/TraitNode.ts`),
    cloned in `src/nodes/clone_node.ts`.
  - `parse_trait.ts` now accepts `<T, U, …>` after the trait name; conformance
    in `parse_struct.ts` is parsed as `Name` optionally followed by `<args>`
    (each arg via `parse_type`). The base trait name still lives in
    `StructNode.traits` (vtable dispatch keys on the name), with the args kept
    in a parallel `StructNode.trait_args: (Type[] | undefined)[]`.
  - The checker registers a generic trait's `type_params`
    (`check_trait_node.ts`) so its own method/field signatures may reference
    them, and `check_struct_node.ts` arity-validates each conformance against
    the trait's `type_params` (missing/extra/`0-arg-trait-with-args` all error).
  - **No build changes were needed**: vtable layout is keyed by trait name, so
    type args don't change `_Struct_traits` / `_get_trait_func` / the aarch64
    per-struct `_<Struct>_traits` array — a generic trait dispatches exactly
    like its non-generic counterpart. Verified end-to-end on **both** backends
    in `test/trait_generic.test.ts` (marker trait, abstract-method override,
    multi-param trait, parametric `struct Wrap<T>: Greetable<T>`, and
    heterogeneous `ClassBuffer<Greetable>` destroy dispatch with two conformers
    carrying different type args).
  - **Still out of scope** (follow-ups): (a) trait **bounds on struct type
    params** — `struct Container<T: Control>` (`:` constraining `T`, not
    conformance) is a separate feature; (b) **generic trait default-method
    bodies that reference `T`** need per-conformer monomorphization (abstract
    methods with no body + concrete overrides already work); (c) nested type
    args in conformance like `Greetable<Wrap<int>>` hit the pre-existing `>>`
    tokenizer edge case.
- ~~**Trait-typed destroy propagation for local variables.**~~ ✅ **Done.**
  A trait-typed local (e.g. `var Speaker s = Dog("Rex")`) now runs the
  concrete struct's `#destroy` and reclaims its owned fields at scope exit on
  both backends. Previously the auto-free passes looked up `dec.type.name`
  (the trait) in `status.structs`, found nothing, and silently skipped the
  local — leaking owned heap data and dropping `#destroy` side effects. The
  fix recovers the concrete struct from the initializer
  (`type_from_value_node(dec.value)`) and dispatches destroy through it:
  `build_c/build_auto_free.ts` for the C backend, and
  `build_aarch64/utils/auto_destroy.ts` (`resolve_decl_struct` helper in
  `emit_destroy_for_scope`) for aarch64. Runtime-tested on both backends in
  `test/trait_local_destroy.test.ts` (user `#destroy` side effects, auto
  destroy of owning fields, multiple owning fields).

## Trait dispatch (polymorphic calls)

Calling a method or reading a field through a _trait-typed_ receiver (a
variable or parameter declared as the trait) routes through a runtime vtable.
Both backends now implement this end-to-end and are exercised by
`test/trait_dispatch.test.ts`, which compiles + runs on **both** `c` and
`aarch64` (previously the path had _no_ runtime coverage on either backend).

- **C backend** (`build_c/build_struct_node.ts:228`,
  `build_c/build_root_node.ts:38`): the `_Struct_traits` vtable +
  `_get_trait_func(obj, trait_index, func_index)` resolver were already
  present but **broken** at the call site. `build_vtable_target` emitted the
  by-value struct instead of a pointer, the function-pointer cast was
  hard-coded to `char *(*)(void *)` (string return, no params), and trait-typed
  locals generated invalid C (`Speaker s = Dog_init()`). Fixed: the target now
  yields a pointer; the cast is derived from the trait method's real signature
  (return type, `self`, arbitrary params); trait-typed locals are declared with
  the concrete struct's storage.
- **aarch64 backend** (`build_aarch64/build_struct_node.ts` `build_struct_traits`,
  `build_aarch64/build_access_node.ts`): new. Emits, per trait-conforming
  struct, a `_<Struct>_<Trait>_funcs` table (overrides, else trait defaults,
  then per-field `get`/`set` pairs) and a `_<Struct>_traits` array indexed by
  global trait order. The struct's init stores `&_<Struct>_traits` at offset 0
  (the `VT_SIZE` slot reserved since v1). Trait-typed dispatch loads
  `[obj] → [vtable, #trait*8] → [trait, #func*8]` into a scratch pair (`x9`/`x10`)
  and `blr`s, leaving the argument registers untouched. The lookup uses scratch
  registers so it works whether or not the trait method declares `self` (a
  no-self method is flagged `is_static` and skips self-loading, but still
  dispatches). Vtable data lives in the `__DATA` segment (absolute `.quad`
  relocations are illegal in `__TEXT` on macOS arm64) and is addressed via
  `adrp`+`add` (`@PAGE`/`@PAGEOFF`).

### Remaining dispatch limitations (pre-spec, follow-up)

- Trait-typed locals use the **concrete** storage of their initializer, so a
  `var Speaker s = Dog(); s = Cat()` reassignment to a _different_ concrete
  type does not yet work (the storage is sized for the first type).
- Trait field accessors handle scalar/string (single-word) fields only;
  multi-word struct trait fields are not yet supported through dispatch.

### Smaller compiler bugs hit while building v1

- **aarch64 backend does not spill function args 9+ to the stack.** The
  prologue (`build_aarch64/build_function_node.ts`) spills each incoming param
  with `str ${param_regs[idx]}`, but `param_regs` only covers `x0`–`x7`; the
  9th parameter indexes past the array and emits `str undefined, [...]`, and
  the matching call site concatenates the overflow arg onto the previous
  instruction (`ldr x0, [x29, #24]mov x0, #0`). The malformed assembly then
  fails to assemble. This was latent until `Container.append_node` (10 params)
  became the first function in the codebase to exceed the 8-register ABI limit
  — which silently broke `app/src/main.nm` on `--arch aarch64`. Worked around
  by refactoring `append_node` to drop `w`/`h` (leaves store them after the
  call), keeping every function at ≤8 register params. A real fix needs full
  AAPCS64 stack-arg passing at both the prologue and the call site.
- ~~**Default parameter on a struct method crashes the checker**
  (`check_function_call.ts:307`, `func_param.type` undefined). Default params on
  free functions work; on methods they don't. Worked around with overloads.~~ ✅
  **Fixed.** The default-fill loop indexed `func.params[node.params.length]`
  without skipping the implicit `self` slot, so a method call that omitted a
  defaulted param pushed one default too many and the per-arg pass read past the
  end of `func.params`. The loop now bounds against `func.params.length -
self_offset` and indexes with `+ self_offset`. Runtime-tested in
  `test/structs.test.ts` ("struct method with default param").
- ~~**Tuple return from a struct method doesn't propagate its type** to the
  caller (`returns_value` doesn't flag tuple returns for forward inference, so
  `var f = m.frame(); f._0` → "Field not found: _0"). Worked around with a
  `fmt_frame` string accessor.~~ ✅ **Fixed** (verified: a method with
  `out [int, int]` returning `[self.x, self.y]` infers a tuple-typed result on
  both backends; `var f = s.frame(); f._0` / `f._1` type-check and build).
- ~~**Overload resolution can't type field-access arguments**
  (`type_from_value_node` returns empty for `a.b`), so count-based overloads
  fall through to the last candidate. Avoided by making `span` required.~~ ✅
  **Fixed** (verified: a count-based method overload `g(int)` / `g(int, int)`
  resolves `p.g(p.a, p.b)` to the two-arg variant).
- **aarch64 inlined `aarch64_use_c` FFI helpers into no-ops** (the bug behind
  "every control renders at the bottom of the screen"). `scan_inline_candidates`
  marked raw-block free functions like `apply_frame`/`is_visible` as inlineable;
  at the call site `build_inline_function` set up the argument registers then ran
  the body — but an `aarch64_use_c` body is C source for the companion file, not
  inline asm, so it emitted nothing inline and returned `true`, suppressing the
  `bl apply_frame`. `setFrame:` therefore never ran and every native control kept
  its creation frame (`0,0` / `10,10` = bottom-left). **Fixed** in
  `scan_inline_candidates.ts`: any function with a `raw` statement is excluded
  from inline candidacy, so it lowers to a real `bl` to the standalone companion
  symbol. (The C backend was never affected — it has no inline pass.) Verified by
  reading native frames back on both backends: `title` resolves to `y=454` in a
  500-tall window (top area) on both `c` and `aarch64`.

### Geometry types (Phase 2) blockers

Implementing the geometry types in [Data types](#data-types) as specified —
flat structs plus the `LayoutLength` / `Alignment` enums — surfaces several
compiler gaps. Each was isolated to a minimal repro compiled on **both** `c`
and `aarch64` via `build_and_check_output`; none are worked around in core yet,
so the spec'd forms stay unusable until fixed. The handle-based v1 sidesteps all
of them by using flat `Buffer<int>` arrays + `int` tag constants, which is also
why `test/layout_container.test.ts` only runs on the `c` backend today.

Struct / initialisation:

- ~~**`var T c = self` in a by-value method miscompiles.** `self` is passed as a
  pointer even in `(self, …)` methods, so `var Box c = self` lowers to
  `struct Box c = self;` in C ("initializing 'struct Box' with an expression of
  type 'struct Box *'"). The `tighten_*` helpers in [Data types](#data-types)
  use exactly this copy pattern; today they must build a fresh struct and copy
  fields one at a time. Fix: dereference `self` for value methods, or lower
  struct value-copy correctly on both backends.~~ ✅ **Fixed.** `build_value_node`
  now dereferences `self` uniformly when it's a pointer param (i.e. not a
  custom `#init`'s local-by-value `self`), so `var T c = self` and `return self`
  both copy the struct. Callers that need the pointer (field access, method
  dispatch, ref-param forwarding) set `suppress_dereference` and get the bare
  pointer. Runtime-tested on both backends (`struct_value_method_copy_self`).
- **Named-field struct literals don't parse.** `const LP DEF = [ grow = 2,
  shrink = 3 ]` fails with "Type mismatch in declaration: unknown value ?". The
  `[ field = val, … ]` construction form used for `DEFAULT_PARAMS` in
  [Data types](#data-types) is unrecognised — only `Type()` (defaults) +
  per-field assignment works today.
- **Struct field of struct type loses its defaults.** `pub var Inner child =
  Inner()` reads the inner's fields back as `0`, not `Inner`'s declared
  defaults. Nested-struct default initialisation doesn't propagate, so a
  `LayoutParams` holding two `LayoutLength` fields can't rely on field defaults.
- **Module-level `const int` as a struct field default is illegal on aarch64.**
  `pub var int hi = INF` (with `const int INF = 2147483647`) produces "Illegal
  text-relocations … to 'INF'" — the field-init load references the global
  symbol from `__TEXT`. Works on `c`; this went uncaught because the container
  tests are `c`-only. Field defaults must currently be literals.

Enums:

- **Shorthand enum-with-args assignment doesn't resolve.** `w = .fixed(50)`
  errors "Function not found: ." Shorthand is only wired for no-arg cases in
  assignment context; cases with associated data must use the full form. The
  spec's `LayoutLength` (`.fixed`, `.percent`) leans on this.
- **Reassigning an enum local to a different associated-data case corrupts it.**
  `var Len w = .auto; w = Len.fixed(50)` then prints `61`, not the `fixed` case
  index `1`, on the `c` backend — the tag/payload get garbled on case change.
- **`match` associated-data extraction is broken on aarch64.**
  `match w { case .fixed(n) -> n }` fails `clang -c` with "unknown AArch64
  fixup kind! `adr x0, n`" — the bound variable `n` is emitted as a symbol
  address instead of the extracted payload. Works on `c`; this alone rules out
  `LayoutLength`-style enums until fixed.
- **No-arg enum case as a struct field default is broken on aarch64.**
  `pub var Align a = .stretch` fails to link: "Undefined symbols for
  architecture arm64: `_Align_stretch`, referenced from: int_to_string". So even
  the caseless `Alignment` enum can't be used as a field default on `aarch64`
  (works on `c`).

Resolution: until these land, geometry types must either (a) stay as flat
`int`-field structs + `int` tag constants (mirroring `Container.nm`'s SoA
buffers), or (b) wait for the compiler fixes above. The math in
[The algorithm](#the-algorithm) is independent of the representation.

### Layout features still owed (now unblocked)

With the native controls now `class`es and `ClassBuffer<Trait>` polymorphic
storage in place, the trait-based `Container : Control` / `Array<Control>`
design is now reachable — the remaining work is Nomen-side (library) rather
than compiler-side. The features below can be implemented in one of two
places: on the existing handle-based v1 (no trait model needed), or on a new
trait-based Container once the geometry types below are in place.

- `BoxConstraints` / `Size` / `Frame` / `Insets` / `LayoutLength` /
  `LayoutParams` with `grow`/`shrink`/`percent`/`fill`/`align` — **blocked** on
  the language gaps in
  [Geometry types (Phase 2) blockers](#geometry-types-phase-2-blockers)
  (enum associated-data, named-field struct literals, and const/nested/enum
  field defaults all miscompile; several only on `aarch64`).
- Intrinsic-size measurement (query each native control's
  `intrinsicContentSize`/`fittingSize`) so `add` needs no size hints.
- Incremental/dirty relayout (v1 does a full re-measure on every
  `layout(win)`/`compute` call; cheap for small UIs).
- **Trait-typed retrieval from a `ClassBuffer<Trait>`** — `var Speaker p =
pets.at(0)` (where the local's initializer is a method-call return rather
  than a constructor) still falls through the trait-typed-local path today
  (only constructor initializers are handled). Once that local-init path is
  generalised the round-trip will work — the slot already stores a correct
  vtable-bearing class pointer.

> `ZStack` and nested containers (VStack/HStack/Grid/ZStack composed to any
> depth) now ship in the handle-based v1 — see `Container.add_*` /
> `root_index`. They were doable without the trait model because the SoA
> `kinds` buffer already provides tag dispatch and `measure`/`arrange` already
> recurse through the parent/child tree.

### Cleanup

- `core/System/Controls/Layout.nm` is the **legacy** SoA engine (integer-index
  tree API). It is superseded by `Container.nm` and no longer used by the app,
  but is kept (and tested by `test/layout.test.ts`) until consumers migrate.
  Remove it once `Container` covers its use cases.
- The aarch64 backend's companion-file path now links and runs a full GUI app
  (`app/src/main.nm` builds and displays correctly on `--arch aarch64`). The
  earlier `_main`/`Window_create_c` symbol issues are resolved, and the inline
  bug above is fixed, so aarch64 GUI is shippable. (The C/macOS backend remains
  the faster path for development.)
