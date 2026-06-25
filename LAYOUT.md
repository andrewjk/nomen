# Layout engine

This is a rough spec for a layout engine for the echo core System/Controls user interface functionality.

It should take a tree of items that conform to the Boundable trait, which exposes a struct containing min_width, max_width, min_height, max_height, width, can_grow, can_shrink.

It should do one pass down the tree and then one pass up.

On the down path we set min_width and max_width, and on the up pass we set width to a concrete value.

Each control needs to conform to this trait (including the existing Window and Text).

At first, the root Window control has min_width 0 and max_width the pixel width of the window. All child controls must fit within these bounds. It also has min_height 0 and max_height set to unbounded somehow (maybe this should be an enum?), meaning that controls can extend as far downward as they need to.

When we reach a control that has a specific width on the downward pass, we need to update the min_width of its parents. Ditto for height.

Let's just assume that all chars are 8px wide for the purposes of calculating font width for now.

We need some layout controls:
VStack
HStack
ZStack
Grid
Block -- a generic rect, the equivalent of a div or span

Implement a first pass at this, and make a load of tests.
