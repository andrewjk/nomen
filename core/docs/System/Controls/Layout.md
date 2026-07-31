# Layout

## `struct Layout`

A flat, buffer-backed layout tree — nodes stored in parallel arrays for the layout engine

## `func init_layoutinit_layout(ref Layout l, int cap)`

Initializes a Layout tree with capacity for `cap` nodes

## `func add_leafadd_leaf(ref Layout l, int parent, int w, int h) -> int`

Appends a leaf node (a sized control) under `parent` and returns its index

## `func add_vstackadd_vstack(ref Layout l, int parent, int spacing) -> int`

Appends a vertical stack container under `parent` and returns its index

## `func add_hstackadd_hstack(ref Layout l, int parent, int spacing) -> int`

Appends a horizontal stack container under `parent` and returns its index

## `func measure_wmeasure_w(Layout l, int count, int idx, int min_w, int max_w, int min_h, int max_h) -> int`

Measures node widths against the given constraints (layout measure phase)

## `func arrangearrange(Layout l, int count, int idx, int x, int y, int w, int h) -> void`

Assigns concrete frames to nodes (layout arrange phase)

## `func run_layoutrun_layout(ref Layout l, int count, int root, int avail_w, int avail_h)`

Runs a full measure-then-arrange pass from `root` within the available space

## `func fmtfmt(Layout l, int idx) -> string`

Formats a node and its subtree as a string (for debugging)
