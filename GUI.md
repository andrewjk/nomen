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
- **`add(handle, w, h, span)`** / **`add(handle, w, h, span, grow)`** /
  **`add(handle, w, h, span, grow, align)`** / **`add(handle, w, h, span, grow, align, shrink)`** —
  append a leaf control by its native handle. `w`/`h` of `0` mean "fill" on the
  cross axis (and "no intrinsic opinion" on the main axis, where `grow` then
  absorbs the surplus); `span` is the grid column count (use `1` for stacks).
  `grow` (default `0`) is the flex weight for sharing surplus space on the
  parent's main axis; `align` (default `ALIGN_STRETCH`) is the cross-axis
  alignment (`ALIGN_START`/`ALIGN_CENTER`/`ALIGN_END`/`ALIGN_STRETCH`);
  `shrink` (default `0`, the original "hold at intrinsic size" behaviour) is
  the flex weight for sharing a **deficit** when the children's main-axis total
  exceeds the available space. The trailing params default, so existing 4/5/6-arg
  `add` calls keep working.
- **`add_kind(handle, w_kind, w_val, h_kind, h_val, span, …)`** /
  **`add_to_kind(parent, handle, w_kind, w_val, h_kind, h_val, span, …)`** —
  append a leaf with an explicit per-axis size kind: `w_kind`/`h_kind` are
  `LEN_*` constants (`LEN_AUTO`/`LEN_FIXED`/`LEN_PERCENT`/`LEN_FILL`, matching
  the `LayoutLength` enum case order in `Geometry.nm`); `w_val`/`h_val` are the
  pixel count for `LEN_FIXED` or the percent numerator (0–100) for `LEN_PERCENT`
  (ignored for `LEN_AUTO`/`LEN_FILL`). The legacy `add(handle, w, h, …)` is the
  special case where non-zero `w`/`h` map to `LEN_FIXED` and `0` maps to
  `LEN_AUTO`. Use `add_kind` for `LEN_PERCENT` (e.g.
  `add_kind(0, LEN_PERCENT, 50, LEN_FIXED, 30, 1)` asks for 50% of the cross
  axis and a fixed 30 px on the main axis) or for an explicit `LEN_FILL`.
  (Passing `LayoutLength` enum values directly —
  `add_len(handle, .percent(50), .fixed(30), …)` — is the ergonomic form this
  API intends, but is held back by an aarch64 codegen gap: 16-byte
  enum-with-data values aren't yet passed by value across the call ABI. See
  [Layout features still owed](#layout-features-still-owed-now-unblocked).)
- **`add_to(parent, handle, w, h, span)`** — append a leaf under an explicit
  parent node (returned by one of the `add_*` container helpers below); accepts
  the same optional `grow`/`align`/`shrink` trailing params as `add`.
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
- **Flex (`grow`) + cross-axis alignment** — `VStack`/`HStack` distribute any
  surplus on their main axis between children weighted by `grow` (e.g. a button
  with `grow = 1` fills the remaining height/width), and position each child on
  the cross axis by `align` (`start`/`center`/`end`/`stretch`, default stretch =
  the original "fill the cross axis" behavior). The root stack fills its main
  axis to the available size so `grow` has surplus to absorb; nested stacks get
  the same treatment automatically because `arrange` runs recursively. Defaults
  preserve the old layout, so every existing `add`/`compute` result is unchanged.
- **`shrink` (deficit distribution) + `percent` / explicit `LEN_*` sizing** —
  the mirror of `grow`: when the children's main-axis total exceeds the
  available space, the deficit is shared between shrinkable children weighted by
  `shrink` (default `0`, so by default children hold at their intrinsic size and
  the overflow surfaces as before; an over-weighted sibling is floored at 0
  rather than dragging others negative). Per-axis requested size is now stored
  as a `(kind, value)` pair mirroring the `LayoutLength` enum
  (`LEN_AUTO`/`LEN_FIXED`/`LEN_PERCENT`/`LEN_FILL`); the legacy `add`/`add_to`
  helpers translate their int `w`/`h` (`0` → auto, non-zero → fixed), and
  `add_kind`/`add_to_kind` accept any case directly so a child can ask for, say,
  `LEN_PERCENT 50` of the cross axis. `LEN_PERCENT` resolves to `p%` of the
  bounded axis (0 on an unbounded axis, where `grow`/`shrink` keep driving the
  layout).

Children flow left→right, top→bottom; a child whose `span` won't fit in the
remaining columns wraps to the next row. `ZStack` overlaps its children (each
gets the stack's full frame; the stack sizes to its largest child). Geometry is
validated by `test/layout_container.test.ts` (vstack, hstack, zstack, grid
span/row/mixed, nested stacks/grids, **grow/align distribution, shrink deficit
distribution, and `LEN_PERCENT`/explicit `LEN_*` sizing**).

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
2. **Geometry types.** ✅ Shipped as `core/System/Controls/Geometry.nm` — the
   flat `Size`/`Frame`/`Insets`/`BoxConstraints` structs, the `LayoutLength`/
   `Alignment` enums, and `LayoutParams` + a `DEFAULT_PARAMS` constant, all
   as specified in [Data types](#data-types). Compile + run on both `c` and
   `aarch64` backends (verified by `test/geometry_types.test.ts`). The
   compiler gaps that previously blocked them are closed (see
   [Geometry types (Phase 2) blockers](#geometry-types-phase-2-blockers)).
   Wiring them into the layout engine's measure/arrange math is the remaining
   library-side work — the math above is independent of the storage
   representation, so the handle-based v1 keeps working until that migration.
3. **Block + Spacer leaf.** ✅ Both shipped handle-based (no trait model
   needed). `Container.add_spacer` / `add_spacer_to` is a flexible empty leaf
   (handle 0) with a `grow`/`shrink` weight that absorbs main-axis
   surplus/deficit and pushes real controls apart. `Container.add_block` /
   `add_block_to` is a single-child container with insets (`KIND_BLOCK`):
   `measure` subtracts the padding from the constraints and returns the child
   size plus the insets; `arrange` forwards the content rect to the child
   (width/height-affects-padding tested on both backends in
   `test/layout_container.test.ts`). Both recurse through the SoA tree like the
   other containers, so the trait model isn't required for the layout math.
4. **VStack then HStack.** ✅ Implemented handle-based, with padding/spacing,
   fill semantics, **`grow` (flex) surplus distribution on the main axis, and
   cross-axis `align`ment** (`start`/`center`/`end`/`stretch`), **plus
   `shrink` (deficit distribution), `LEN_PERCENT`, and explicit `LEN_*`-driven
   sizing via `add_kind`/`add_to_kind`**. Per-axis requested size is now stored
   as a `(kind, value)` pair mirroring the `LayoutLength` enum
   (`LEN_AUTO`/`LEN_FIXED`/`LEN_PERCENT`/`LEN_FILL`); the legacy `add`/`add_to`
   helpers translate their int `w`/`h` (`0` → auto, non-zero → fixed), so
   existing `add`/`compute` results are unchanged (verified on both backends by
   `test/layout_container.test.ts`). Passing `LayoutLength` enum values
   directly (`add_len(handle, .percent(50), …)`) is the one ergonomic form still
   blocked — by an aarch64 codegen gap (16-byte enum-with-data isn't yet passed
   by value across the call ABI); see
   [Layout features still owed](#layout-features-still-owed-now-unblocked).
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
   [Smaller compiler bugs](#smaller-compiler-bugs-hit-while-building-v1); since
   fixed, so `Container`'s helpers no longer need to stay at ≤8 register
   params.)
8. **Invalidation.** ✅ **Incremental/dirty relayout** is implemented in
   `Container` on both backends — a per-node `dirty` flag with `mark_dirty`
   (propagates up to the root and down through descendants), `measure` skips
   clean subtrees (reusing the cached size), `compute`/`layout` mark the whole
   tree dirty only when the available size changes, and `measure_count` lets
   tests observe which subtrees were re-measured. `app/src/main.nm` calls
   `grid.mark_dirty(grid.root_index())` before `layout(win)` so visibility or
   content changes are picked up. The early `return` of a cached size inside
   the recursive `measure` previously miscompiled on aarch64 — a
   buffer-cache register-reuse bug that collapsed ZStack children to height 0
   (width survived); now fixed (see [Smaller compiler bugs](#smaller-compiler-bugs-hit-while-building-v1)).
   Verified on both backends by the incremental tests in
   `test/layout_container.test.ts`.
9. **Compositor features.** ⚠️ Partial: **hit testing** shipped as `Container.hit_test` /
   `hit_test_index` — a pure-rect-math, front-to-back walk of the frame tree that
   returns the frontmost leaf containing a point (verified on both backends in
   `test/layout_container.test.ts`). **Dirty-rect tracking** shipped as
   `Container.dirty_count` / `dirty_rect`: a leaf enters the dirty list only when
   its resolved frame differs from its previously-applied baseline, and `apply`
   repaints only those leaves (a repeat layout at the same size is a no-op).
   Verified on both backends in `test/layout_container.test.ts`. Deferred:
   animation.

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

- ~~**Trait-typed locals use the **concrete** storage of their initializer, so
  a `var Speaker s = Dog(); s = Cat()` reassignment to a _different_ concrete
  type does not yet work (the storage is sized for the first type).~~ ✅
  **Fixed.** A trait-typed local whose concrete storage is a `class` now holds
  a pointer to the heap instance (not the inline struct), so it can be
  reassigned to any other class conforming to the same trait. Dispatch reads
  the vtable through the stored pointer, and both reassignment and scope-exit
  reclaim the instance via the trait's `<Trait>_destroy` shim (the concrete
  type at runtime may differ from the initializer's after a reassignment, so
  destroy dispatches polymorphically). Runtime-tested on both backends in
  `test/trait_dispatch_gaps.test.ts`. (Value-struct trait-typed locals keep
  their inline stack storage and still cannot be reassigned across concrete
  types — that would require boxing, which was removed; declare the type as a
  `class` to use it polymorphically.)
- ~~**Trait field accessors handle scalar/string (single-word) fields only;
  multi-word struct trait fields are not yet supported through dispatch.~~ ✅
  **Fixed.** The generated get/set accessors now use the full field type
  (`struct Point`, not `Point`) and copy the complete value, so a trait field
  whose type is a struct wider than one word reads and writes correctly
  through a trait-typed receiver. Runtime-tested on both backends in
  `test/trait_dispatch_gaps.test.ts`.
- **16-byte enum-with-data (and struct) values aren't passed by value on
  aarch64.** When a `LayoutLength` (a 16-byte enum-with-data: 8-byte tag + 8-byte
  payload) is passed by value as a function parameter, the aarch64 call-site
  codegen stores only the first 8 bytes of the argument into the per-arg spill
  slot (`build_aarch64/build_function_call_node.ts`: `args_base + i * 8`) and
  loads a single word into the target register, so the callee sees a garbled
  value (the case index only — the payload is dropped). Symptomatic as
  `add_len(handle, .fixed(100), .fixed(30), …)` resolving every `LayoutLength`
  arg to `LEN_AUTO` on aarch64 while working on `c`. The C backend passes the
  struct by value correctly (the C compiler handles the 16-byte copy). Worked
  around in `Container.nm` by exposing `add_kind`/`add_to_kind`, which take the
  `(kind, value)` pair as plain `int` parameters (`LEN_*` constants) and so
  never trip the gap; the ergonomic `add_len(LayoutLength, LayoutLength, …)`
  form stays unimplemented until the aarch64 call ABI handles multi-word
  by-value parameters (either two registers per 16-byte arg per AAPCS64, or an
  indirect-by-pointer convention matched on both sides).

  Two related aarch64 fixes landed alongside the layout work above (neither
  fixes the by-value gap, but both were unblocked by it):

  - **Switch labels collided with match labels.** `build_switch_node` and
    `build_match_node` both used the same `case_next_${label}_${i}` prefix with
    independent module-level counters that were never reset in `build.ts`. As
    soon as a function had both a `match` and a `switch` (the new leaf-measure
    code has two switches, plus `length_kind`/`length_val` were matches), the
    numeric `label`s collided and the assembler rejected the duplicate symbol
    definitions. Fixed: switch labels are now `sw_next_${label}_${i}` and both
    counters are reset per build alongside the for/if/while/func counters
    (`src/build.ts`).
  - **The aarch64 backend never emitted hoisted `_param_N` call-arg
    temporaries.** The checker hoists complex call args (anything that isn't a
    bare `value` node — e.g. an inline `.fixed(100)` enum value, an
    interpolated-string helper result, a `self.count + 1` arithmetic arg) into
    local `_param_N` declarations attached to the consuming node, then rewrites
    the call site to reference the local by name. The C backend surfaces these
    via `emit_allocations` (called per statement from `build_block_node`),
    which recursively collects them and emits them before the consuming
    statement; the aarch64 `build_block_node` had no equivalent, so the
    declarations were never emitted and the assembler saw `adr x0, _param_N`
    relocations against undefined labels. Fixed: aarch64 now has its own
    `utils/emit_allocations.ts`, wired into `build_block_node` the same way.
    Because the AST is shared across the aarch64 and C builds (the test
    harness parses once, builds twice), the aarch64 version deliberately does
    NOT mutate `node.allocations` (the C version clears-as-it-goes); instead,
    both `emit_allocations` and the inline `if (node.allocations)` path in
    `build_node` consult a per-build `status.emitted_allocations` set so an
    allocation is emitted at most once per backend.

### Smaller compiler bugs hit while building v1

- ~~**aarch64 backend does not spill function args 9+ to the stack.** The
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
  AAPCS64 stack-arg passing at both the prologue and the call site.~~ ✅
  **Fixed.** All four aarch64 prologue paths (regular functions, struct
  auto-`#init`, struct methods, custom `#init`) and all three call-site paths
  (free-function calls, method calls via `build_access_node`, and constructor
  calls in declarations) now implement AAPCS64 stack-arg passing. Incoming
  overflow args (slot 8+k) are loaded from `[x29, #(16 + 16*callee_saved_pushes
\+ STACK_SIZE + k*8)]` via text placeholders patched once the local frame
  size is known (`src/build_aarch64/utils/stack_args.ts`); outgoing overflow
  args are spilled to a temporary outgoing area below `sp`, freed immediately
  after the `bl`. The variadic-tuple + overflow combination is the remaining
  gap (only the count/ptr slot pair is supported in registers today).
  Regression-tested on both backends in `test/many_params.test.ts` (9-, 10-,
  11-, 12-arg free functions; 10-field struct auto-`#init`; 9-arg instance
  method; nested overflow call).
- ~~**C backend auto-`#init` local name collides with a same-named field.**
  `build_c/build_struct_node.ts:148` derives the constructor's local instance
  variable from the struct name's first letter lowercased (`Big` → `b`); if
  the struct has a field with that name, the local shadows the parameter and
  the field self-assigns (`b.b = b;`). Surfaces for any struct whose name's
  first letter (lowercased) matches one of its field names (e.g. `struct Big {
var int b }`). Workaround: rename either the struct or the field. A real fix
  should use a non-colliding local name (e.g. `_self` or `__self`).~~ ✅
  **Fixed.** The auto-generated `#init` now uses `_self` as the local instance
  variable name (matching the convention already used by the method-build
  path for dereferenced `self`), so it can no longer collide with a
  field-derived parameter. Runtime-tested on both backends in
  `test/structs.test.ts` ("auto-init local does not collide with field name").
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
- **aarch64 buffer-cache register reuse collapsed ZStack children to height 0.**
  The inlined `Buffer.load_int`/`store_int` fast path caches each Buffer's data
  pointer in a callee-saved register (x23-x28), tracked by the per-function
  `buffer_data_cache` Map. That Map is snapshotted/restored across if/switch/
  match/loop bodies (a sub-scope gets a copy; on exit the outer Map is brought
  back), but the registers themselves are physical state shared across the whole
  function. `alloc_buffer_cache_reg` only excluded registers claimed in the
  _current_ scope's Map, so a sub-scope (the ZStack loop body, which needed two
  cached buffers — `rw` and `rh`) could reassign a register that an outer
  scope's Map still referenced (`dirty`). The post-loop `dirty.store_int` then
  wrote through the now-stale register, landing on `rh` and zeroing the cached
  heights (width survived because it used a different buffer). Symptomatic only
  on ZStack because VStack/HStack loop bodies happened to need just one cached
  buffer at a time. Fixed in `src/build_aarch64/build_access_node.ts`:
  `alloc_buffer_cache_reg` now also excludes `callee_saved_regs_used`, the same
  function-wide set used to pick prologue saves and to protect loop-promoted
  variables. Once a register has been claimed anywhere in the function it stays
  claimed for the function's duration, so no sub-scope can clobber an outer
  cache entry. Runtime-tested on both backends by `test/layout_container.test.ts`
  (the `aarch64 measure-skip regression (fixed)` block — formerly a known-failure
  regression for the misdiagnosed "label collision" form of this bug).

### Geometry types (Phase 2) blockers

Implementing the geometry types in [Data types](#data-types) as specified —
flat structs plus the `LayoutLength` / `Alignment` enums — surfaces several
compiler gaps. Each was isolated to a minimal repro compiled on **both** `c`
and `aarch64` via `build_and_check_output`; none are worked around in core yet,
so the spec'd forms stay unusable until fixed. The handle-based v1 sidesteps all
of them by using flat `Buffer<int>` arrays + `int` tag constants.
`test/layout_container.test.ts` runs on both backends.

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

Enums:

- ~~**Shorthand enum-with-args assignment doesn't resolve.** `w = .fixed(50)`
  errors "Function not found: ." Shorthand is only wired for no-arg cases in
  assignment context; cases with associated data must use the full form. The
  spec's `LayoutLength` (`.fixed`, `.percent`) leans on this.~~ ✅ **Fixed.**
  The parser now passes the parsed ValueNode's value (e.g. `.fixed`) as the
  FunctionCallNode's name rather than the leading `.` peek; the checker
  resolves `.case(args)` against `expected_type`'s enum, rewrites it to the
  mangled `Enum_case` form with `is_enum_shorthand = true`, and the C and
  aarch64 backends lower it as `Enum_case_init(args)` / a tag+payload temp.
  Runtime-tested on both backends (`enum_shorthand_with_args_assign`).
- ~~**Reassigning an enum local to a different associated-data case corrupts it.**
  `var Len w = .auto; w = Len.fixed(50)` then prints `61`, not the `fixed` case
  index `1`, on the `c` backend — the tag/payload get garbled on case change.~~
  ✅ **Fixed.** Root cause was two-fold: (a) the aarch64 assignment path stored
  only the constructor temp's address (`str x0, [x29, #0]`) instead of
  struct-copying the multi-word tag+payload, so the variable's tag became a
  stack-pointer; (b) the aarch64 `build_value_node` emitted only the case
  index for a no-arg case of an associated-data enum, leaving the payload
  uninitialised. The assignment path now struct-copies the full enum bytes
  (`is_enum_with_data_type` branch in `build_assignment_node`), and
  `build_value_node` allocates a tag+payload temp (tag at +0, zeroed payload)
  for associated-data enums. The C backend's value node likewise emits
  `Enum_case_init()` for no-arg cases of associated-data enums. Runtime-tested
  on both backends (`enum_reassign_associated_case`,
  `enum_reassign_match_payload`).
- ~~**`match` associated-data extraction is broken on aarch64.**
  `match w { case .fixed(n) -> n }` fails `clang -c` with "unknown AArch64
  fixup kind! `adr x0, n`" — the bound variable `n` is emitted as a symbol
  address instead of the extracted payload. Works on `c`; this alone rules out
  `LayoutLength`-style enums until fixed.~~ ✅ **Fixed.** `build_match_node`
  (aarch64) now extracts the payload for cases that bind associated data
  (`case .fixed(x) -> …`): for each binding it allocates a stack slot, loads
  the field value from the matched enum (base `x20` + payload offset via
  `get_enum_payload_offset`), and binds the slot to the param name. The
  scrutinee is built with `emit_address_of` (so x20 holds the enum address,
  not just the tag word), and each case's match pattern is emitted as a bare
  case-index `mov` (not the full enum temp). Runtime-tested on both backends
  (`match_associated_data_extract`, `match_associated_data_multi`).
- ~~**No-arg enum case as a struct field default is broken on aarch64.**
  `pub var Align a = .stretch` fails to link: "Undefined symbols for
  architecture arm64: `_Align_stretch`, referenced from: int_to_string". So even
  the caseless `Alignment` enum can't be used as a field default on `aarch64`
  (works on `c`).~~ ✅ **Fixed.** `build_struct_node` (aarch64) recognises
  `is_enum_shorthand` field defaults (both auto-`#init` and custom-`#init`
  paths) and emits the case index immediate directly for simple enums, or a
  tag+payload temp + word-by-word copy for no-arg cases of associated-data
  enums. Previously the field-init fallback emitted `adr xN, Enum_case`, an
  illegal text relocation on macOS arm64. Runtime-tested on both backends
  (`enum_field_default`).
- ~~**Named-field struct literal with an enum shorthand value, and field
  assignment of an enum-with-data, break on aarch64.** `[ width = .fixed(50),
grow = 1 ]` and `p.width = Len.fixed(50)` both misbehave: the override/field
  value reaches the build pass with the enum shorthand unresolved (`adr x0,
.auto`, an illegal text relocation), and the field assignment stores the RHS
  temp's _address_ instead of struct-copying the 16-byte value, so matching the
  field reads a garbage tag. Two coupled root causes: (a) the `field_overrides`
  of a named-field struct literal are never run through `check_node`, so
  `.auto`/`.fixed(50)` aren't rewritten to the mangled enum case with
  `is_enum_shorthand`; (b) `get_type_size` (`struct_layout.ts`) sizes every
  enum as 8 bytes via `aarch64_size`'s default, so a 16-byte enum-with-data
  field is under-counted and the next field's offset overlaps its payload, and
  field assignment of such an enum fell through to a plain `str` of the RHS temp
  address.~~ ✅ **Fixed.** (a) `convert_anon_struct` (`check_declaration_node.ts`)
  and the parallel field-override loop in `check_function_call.ts` now walk each
  override value through `check_node` with the struct field's type as
  `expected_type`, so shorthand enum values resolve to `Enum_case` with
  `is_enum_shorthand = true`. (b) `get_type_size` now returns `get_enum_size`
  for enums (16 bytes for enums-with-data) so `get_field_offset` /
  `get_struct_size` lay fields out correctly; and the aarch64 field-assignment
  path gained an `is_enum_with_data_type` branch that `emit_struct_copy`s the
  full value (mirroring the variable-assignment path). Runtime-tested on both
  backends (`struct_named_field_literal_enum`, `match_field_enum_with_data`).

Resolution: with the enum blockers above fixed, the `LayoutLength` /
`Alignment` enums and enum-field defaults are now usable on both backends, and
named-field struct literals whose override values are enum shorthands
(`[ width = .fixed(50), grow = 1 ]`) resolve and lay out correctly. Geometry
types are shipped as `core/System/Controls/Geometry.nm` (with `LayoutLength` /
`Alignment` / `LayoutParams` / `DEFAULT_PARAMS` split into the sibling
`LayoutParams.nm` — see [Layout features still owed](#layout-features-still-owed-now-unblocked)
for why); see [test/geometry_types.test.ts]. The math in
[The algorithm](#the-algorithm) is independent of the representation.

Two compiler fixes were needed to ship the geometry types themselves (over
and above the enum blockers above):

- **`const` name collision with C `math.h` macros.** A Nomen `const int
INFINITY = 2147483647` lowered to `extern long INFINITY;` and
  `long INFINITY = …;`, which the C preprocessor expanded to
  `__builtin_huge_valf` (a macro from `<math.h>`) and rejected. The geometry
  module renamed its private sentinel to `MAX_DIM`.
- **Top-level non-primitive `const` declarations didn't lower to file scope.**
  `const LayoutParams DEFAULT_PARAMS = [ width = .auto, … ]` became
  `struct LayoutParams DEFAULT_PARAMS = LayoutParams_init();` plus bare
  field-assignment statements at C file scope (invalid: not a constant
  expression) and bare instructions at aarch64 module scope (unreachable).
  both backends now treat a non-primitive top-level `const` as **inlined at
  every use site**: `build_value_node` substitutes the const's initializer,
  `build_declaration_node` substitutes the value at the slot-filling fast
  path, the root `build_block_node` skips emitting the declaration, and the
  checker pre-registers the name (via a `gather_top_level_consts` pass) so
  it's visible to `main`, which is compiled before the library source that
  declares it.
- **Primitive top-level `const`s were invisible to `main` at check time.** The
  build pass already forward-declared them as `extern` file-scope globals
  (`build_c/build_block_node`), but the checker's `gather_top_level_consts`
  deliberately skipped primitive-typed consts to avoid tripping the "Parameter
  already declared" guard when a function param shadows a module-level name.
  So referencing an imported primitive const (e.g. `Container`'s `ALIGN_CENTER`)
  from `main` errored with "Unknown value: ALIGN_CENTER" — meaning a public
  primitive-const API was unusable across modules. Fixed: `gather_top_level_consts`
  now pre-registers **all** top-level consts (carrying just the type, like the
  non-primitive path), and the "Parameter already declared" guard in
  `check_function_parameter_node` ignores `const` entries, so a parameter may
  legitimately shadow a module-level const (correct scoping) while duplicate
  params / `var` collisions still error. Verified across the full suite and by
  `test/layout_container.test.ts`, which references `ALIGN_*` from `main` on
  both backends.

### Layout features still owed (now unblocked)

With the native controls now `class`es, `ClassBuffer<Trait>` polymorphic
storage in place, and the enum geometry-type blockers fixed, the trait-based
`Container : Control` / `Array<Control>` design is now reachable — the
remaining work is Nomen-side (library) rather than compiler-side. The features
below can be implemented in one of two places: on the existing handle-based v1
(no trait model needed), or on a new trait-based Container.

- ~~`BoxConstraints` / `Size` / `Frame` / `Insets` / `LayoutLength` /
  `LayoutParams` with `grow`/`shrink`/`percent`/`fill`/`align` — enum
  associated-data, enum reassignment, `match` payload extraction, enum field
  defaults, and named-field struct literals with enum shorthand values all work
  on both backends now.~~ ✅ The **types** ship as `Geometry.nm` (with
  `LayoutLength`/`Alignment`/`LayoutParams`/`DEFAULT_PARAMS` split out into
  `LayoutParams.nm` so a module that only needs the length model — e.g.
  `Container.nm` — can pull it in without dragging `Size`/`Frame` along; those
  collide with macOS `MacTypes.h` typedefs once any Cocoa-using module joins
  the build), and the **`grow` (flex) + cross-axis `align`ment** math is now
  wired into the handle-based v1 `VStack`/`HStack` arrange pass (root stack
  fills its main axis to the available size so `grow` has surplus to absorb;
  children weighted by `grow` share it; `align` positions each child on the
  cross axis; defaults preserve the old layout). Verified on both backends in
  `test/layout_container.test.ts` (grow-one, grow-split, fixed+flex+grow mix,
  start/center/end/stretch, and grow composed through nesting). ~~Remaining
  from this set: `shrink` (deficit distribution), `percent`, and explicit
  `LayoutLength`-driven sizing.~~ ✅ Also wired in: `shrink` distributes a
  main-axis deficit weighted by `shrink` (default `0` = hold at intrinsic, the
  original behaviour), `LEN_PERCENT` resolves against the bounded axis, and
  `add_kind`/`add_to_kind` accept any `LEN_*` case via a `(kind, value)` int
  pair (the ergonomic `add_len(.percent(50), …)` form is the only piece still
  blocked — see below).
- Intrinsic-size measurement (query each native control's
  `intrinsicContentSize`/`fittingSize`) so `add` needs no size hints.
- ~~Incremental/dirty relayout (v1 does a full re-measure on every
  `layout(win)`/`compute` call; cheap for small UIs).~~ ✅ Shipped on both
  backends: `Container.mark_dirty` propagates up to the root and down through
  descendants, `measure` skips clean subtrees (reusing the cached size), and
  `measure_count` lets tests observe which subtrees were re-measured (see
  [Implementation phases](#implementation-phases) 8). The aarch64 codegen gap
  that previously blocked this is fixed (see [Smaller compiler
  bugs](#smaller-compiler-bugs-hit-while-building-v1)).
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
