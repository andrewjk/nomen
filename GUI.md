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
	var Window win = Window.create("Nomen Todo", 400, 500)
	var Text title = Text.create(win)
	var CheckBox cb0 = CheckBox.create(win)
	var TextBox input = TextBox.create(win)
	var Button add_btn = Button.create(win, "Add")

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

- **`Grid(cols, spacing)` / `VStack(spacing)` / `HStack(spacing)`** factory
  functions returning a `Container`.
- **`add(handle, w, h, span)`** — append a leaf control by its native `handle`.
  `w`/`h` of `0` mean "fill" on that axis; `span` is the grid column count
  (use `1` for stacks).
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
remaining columns wraps to the next row. Geometry is validated by
`test/layout_container.test.ts` (vstack, hstack, grid span/row/mixed).

### Why handle-based, not trait-based (for now)

Every native control is `struct { uint64 handle }`, and the y-flip needs the
window's content height — both are handle-level concerns. But the decisive
reason is the compiler: the `Container : Control` / `Array<Control>` design
below requires three things the compiler does **not** yet do —

1. **aarch64 has no vtable dispatch** (`build_aarch64/build_struct_node.ts:657`
   emits only default-method forwarding stubs; there is no `_get_trait_func`
   equivalent). Calling `child.measure(...)` through a `Control`-typed value
   lowers to nothing on aarch64.
2. **No heterogeneous container storage** — value structs aren't auto-boxed
   into trait-typed slots, and `monomorphize` doesn't route trait-`T` to
   `ClassBuffer`.
3. Trait conformance with type arguments isn't parsed yet (`Viewable.nm:8`).

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
2. **Geometry types.** ⚠️ Deferred. v1 uses raw `int` width/height + the
   `Container`'s flat buffers; the `Size`/`Frame`/`Insets`/`BoxConstraints`/
   `LayoutLength`/`LayoutParams` types are part of the trait migration.
3. **Block + Spacer leaf.** ⚠️ Deferred (needs the trait model).
4. **VStack then HStack.** ✅ Implemented handle-based, with padding/spacing and
   fill semantics (no grow/shrink/percent/alignment yet).
5. **ZStack, then Grid.** ✅ Grid done (flow + column `span`); ZStack deferred.
6. **Refactor Window/Text** to conform to `Control`. ⚠️ Partial: `Window` gained
   `content_width`; controls still expose `handle` for the handle-based API.
   Wiring native `setFrame:` is done inside `Container.apply_frame`.
7. **End-to-end sample.** ✅ `app/src/main.nm` (the todo app) builds and runs on
   the C/macOS backend using a 2-column `Grid`.
8. **Invalidation.** ⚠️ Deferred. v1 does a full re-measure on every
   `layout(win)` call (cheap for small UIs; fine for the todo app).
9. **Compositor features.** ⚠️ Deferred (hit testing, dirty-rect, animation).

## Next steps & compiler prerequisites

To move from the handle-based v1 toward the full `Control`-trait design below,
the compiler needs these (tracked here, not in `SPEC.md`, since they're pre-spec
UI infrastructure):

### Trait system gaps (unblock `Array<Control>` polymorphism)

- **aarch64 vtable dispatch.** Generate per-struct trait function-pointer tables
  and a `_get_trait_func(obj, trait, func)` resolver, mirroring the C backend
  (`build_c/build_struct_node.ts:228`, `build_c/build_root_node.ts:38`). Until
  this exists, trait-typed dispatch is C-backend-only and compile-tested at best.
- **Auto-box value structs into trait-typed container slots**, and make
  `monomorphize` route trait-`T` to `ClassBuffer` (currently only `class` `T` is
  recognized — `check_function_call_node.ts:188`). Otherwise `Array<Control>`
  cannot store heterogeneous value structs.
- **Parse trait conformance with type arguments** (`Viewable.nm:8-11`), so
  `Container<T: Control>`-style generics become possible.
- **Trait-typed destroy propagation** in containers, so owned controls in a
  trait collection are freed correctly.

### Smaller compiler bugs hit while building v1

- **Default parameter on a struct method crashes the checker**
  (`check_function_call.ts:307`, `func_param.type` undefined). Default params on
  free functions work; on methods they don't. Worked around with overloads.
- **Tuple return from a struct method doesn't propagate its type** to the
  caller (`returns_value` doesn't flag tuple returns for forward inference, so
  `var f = m.frame(); f._0` → "Field not found: _0"). Worked around with a
  `fmt_frame` string accessor.
- **Overload resolution can't type field-access arguments**
  (`type_from_value_node` returns empty for `a.b`), so count-based overloads
  fall through to the last candidate. Avoided by making `span` required.

### Layout features still owed (once traits land)

- `BoxConstraints` / `Size` / `Frame` / `Insets` / `LayoutLength` /
  `LayoutParams` with `grow`/`shrink`/`percent`/`fill`/`align`.
- Intrinsic-size measurement (query each native control's
  `intrinsicContentSize`/`fittingSize`) so `add` needs no size hints.
- `ZStack`, nested containers (v1 is flat — nesting needs either the trait model
  or class-based containers with tag dispatch), and incremental/dirty relayout.

### Cleanup

- `core/System/Controls/Layout.nm` is the **legacy** SoA engine (integer-index
  tree API). It is superseded by `Container.nm` and no longer used by the app,
  but is kept (and tested by `test/layout.test.ts`) until consumers migrate.
  Remove it once `Container` covers its use cases.
- The aarch64 backend's companion-file path fails to link a full GUI app
  (`_main`/`Window_create_c` symbol issues) — the app currently targets the
  C/macOS backend. Worth investigating before aarch64 GUI is shippable.
