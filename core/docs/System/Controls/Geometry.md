# Geometry

## `struct Size`

A 2D size (width and height)

## `struct Frame`

A rectangle (x, y, width, height) — a control's assigned position and size

## `struct Insets`

Per-edge padding (top, right, bottom, left)

## `struct BoxConstraints`

Min/max size bounds a parent passes to a child during the layout measure phase

**Members:**

- `tighten_width(int min, int max) -> BoxConstraints`
- `tighten_height(int min, int max) -> BoxConstraints`
- `clamp_width(int value) -> int`
- `clamp_height(int value) -> int`
- `is_width_bounded() -> bool`
- `is_height_bounded() -> bool`
