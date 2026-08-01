# Container

## `func native_intrinsicnative_intrinsic(uint64 handle) -> _Tuple_int_int`

_No documentation._

## `class Container`

A flexbox-style container that measures and arranges its child controls.

Conforms to `Control`: `measure(BoxConstraints)` measures the whole subtree,
`set_frame` arranges it into a rectangle, and `intrinsic_size` reports the
unbounded-content size. The handle-based `add` API and the SoA engine are
unchanged — the trait methods are thin entry points over the existing math,
so a `Container` can also be driven polymorphically as a `Control` (passed to
a `Control`-taking function, stored in a `ClassBuffer<Control>`, etc.).

**Members:**

- `init_buffers(int cap)`
- `make_root(int kind, int gap, int col_count)`
- `first_child(int parent) -> int`
- `next_sibling(int after, int parent) -> int`
- `append_node(int parent, int kind, int handle, int gap, int cols, int span, int grow, int shrink, int align) -> int`
- `root_index() -> int`
- `add(uint64 handle, int w, int h, int span, int grow, int align, int shrink)`
- `add_to(int parent, uint64 handle, int w, int h, int span, int grow, int align, int shrink)`
- `add_kind(uint64 handle, int w_kind, int w_val, int h_kind, int h_val, int span, int grow, int align, int shrink)`
- `add_to_kind(int parent, uint64 handle, int w_kind, int w_val, int h_kind, int h_val, int span, int grow, int align, int shrink)`
- `add_len(uint64 handle, LayoutLength w, LayoutLength h, int span, int grow, int align, int shrink)`
- `add_to_len(int parent, uint64 handle, LayoutLength w, LayoutLength h, int span, int grow, int align, int shrink)`
- `add_intrinsic(uint64 handle, int span, int grow, int align, int shrink)`
- `add_to_intrinsic(int parent, uint64 handle, int span, int grow, int align, int shrink)`
- `set_leaf_size(int idx, int w, int h)`
- `set_leaf_kind(int idx, int w_kind, int w_val, int h_kind, int h_val)`
- `add_vstack(int parent, int spacing, int span, int grow, int align, int shrink) -> int`
- `add_hstack(int parent, int spacing, int span, int grow, int align, int shrink) -> int`
- `add_spacer(int span, int grow, int shrink, int align)`
- `add_spacer_to(int parent, int span, int grow, int shrink, int align)`
- `add_grid(int parent, int cols, int spacing, int span, int grow, int align, int shrink) -> int`
- `add_zstack(int parent, int span, int grow, int align, int shrink) -> int`
- `add_block(int padding, int span, int grow, int align, int shrink) -> int`
- `add_block_to(int parent, int padding, int span, int grow, int align, int shrink) -> int`
- `measure_node(int idx, int min_w, int max_w, int min_h, int max_h) -> int`
- `arrange_node(int idx, int x, int y, int w, int h) -> void`
- `collect_dirty()`
- `dirty_count() -> int`
- `dirty_rect(int i) -> string`
- `mark_dirty(int idx)`
- `measure_count(int i) -> int`
- `apply(int content_w, int content_h)`
- `measure(BoxConstraints constraints) -> Size`
- `set_frame(int x, int y, int width, int height)`
- `intrinsic_size() -> Size`
- `compute(int avail_w, int avail_h)`
- `layout(Window win)`
- `set_resize_callback(Window win)`
- `contains(uint64 handle, int cx, int cy) -> bool`
- `hit_test(int cx, int cy) -> uint64`
- `hit_test_index(int cx, int cy) -> int`
- `hit_test_node(int idx, int cx, int cy) -> int`
- `fmt_frame(int i) -> string`

## `func nomen_layout_thunknomen_layout_thunk(ref Container grid, Window win)`

Entry point the layout engine calls to lay out a Container's tree

## `func VStackVStack(int spacing) -> Container`

Creates a vertical stack container with the given spacing

## `func HStackHStack(int spacing) -> Container`

Creates a horizontal stack container with the given spacing

## `func ZStackZStack() -> Container`

Creates a Z-stack container (children layered on top of one another)

## `func GridGrid(int cols, int spacing) -> Container`

Creates a grid container with `cols` columns and the given spacing
