# Nomen Demos

## Todo

A GUI app with a todo list, built on the **App contract** (`Window.run`):
the app struct builds its controls in `#init`, registers the layout roots
in `start` (`win.set_content` + `todos_grid.set_document`), and its `frame`
hook handles clicks — the framework owns the pump, the pool, resize
detection, and every relayout. The list is unbounded and SCROLLS: the todos
live on a `Scrollable`'s document view in a vertical root whose middle row
grows to fill the leftover height, so however many todos are added the input
row stays pinned at the bottom. On each relayout the framework measures the
todo stack unbounded, sizes the document view to it, and lays the stack out
into that height (the Scrollable design note in GUI.md); an add or delete
re-runs that dance immediately (`nomen_scroll_thunk`) and re-anchors to the
bottom so the newest todo is visible. Each todo creates its own checkbox
when added (Add button), and right-clicking a todo deletes it — the click is
translated into document coordinates with `content_click` first, then the
grid node is removed and the control is freed by moving it into a nested
block, whose closing brace runs the checkbox's `#destroy`. The Add button
is a registered `on_click` handler (dispatched with the app's `ref self`
— docs/HANDLERS.md). The input
field's hint text is a real placeholder (`TextBox.set_placeholder`), so the
field reads empty until the user types.

## Async

A GUI app that fetches five letters (A-E) in parallel. The Fetch button
starts a coordinator fiber whose `async { }` nursery spawns five threads —
each sleeps a random 1-10 s (via `Random`), then reports its letter down a
`Channel`. The letters therefore arrive in **completion order**, so each run
prints a different order, e.g. `Done! B E D A C`. The label flips to
"Fetching..." immediately; the event loop stays responsive by polling the
coordinator's `Task.is_done()` instead of blocking.

## Controls

A gallery of every `System::Controls` control in one window, built on the
**App contract** (`Window.run`): the app struct builds everything in
`#init`, registers the page root + both Scrollables in `start`, and its
`frame` hook is the per-frame body — the framework owns the pump, resize
detection, and the root/document relayouts. Inputs (TextBox, SecureField,
SearchField, TextView), choices (CheckBox, Radio, Switch, Toggle,
Segmented, Select, Stepper, Slider), display (Progress, Spinner,
LevelIndicator, ImageView, DatePicker, ColorPicker), actions (Button +
Tooltip), and grouping (Separator, GroupBox) — laid out in a
2-column grid. Clicks are registered `on_click` handlers — the desugar
dispatches each closure as a hidden method with the app's `ref self`
(docs/HANDLERS.md); composites self-drive and report up — the Pagination
row enrolls the app via `on_page_change`, and each frame's `tick`
delivers changes to it. Continuous controls are polled every frame into a
status line that only rewrites when the string changes. The modals are created up
front and driven from `frame`: Alert (blocks in NSAlert's own
modal loop and reports the button pressed), Sheet (its content window is
its own layout root, hit-tested in sheet coordinates while presented), and
Popover (toggled from an anchor button). A Scrolling section hosts a tall
label stack on a Scrollable's document view — the framework's document
dance sizes and lays it out, with the scroll offset
polled into the status line. A Tabs section hosts one label per page via
`content_window(index)`, with the selected tab polled alongside (the pane
grids re-flow on the first frame and on resize — the app-owned roots). A
ListView section bridges rows into an NSTableView data source, polling the
selected row; a ComboBox polls its selection the same way. A Menu attaches
to the right-click target button — picks surface through the edge-triggered
`clicked_item` poll and land in the status line, as do the window
Toolbar's three labeled buttons (created before the first layout, since
the toolbar shrinks the contentView). A SplitView section lays a label
into each of two draggable panes; an OutlineView bridges a small tree
(sources/demos), with its selected row polled too. A Table section fills a
3-column grid (headers + rows through the view-based reusable cells), with
the selected row polled alongside. A Composites section exercises the Tier 3
pure-Nomen compositions — NumberInput (TextBox + Stepper, hundredths),
OtpInput (five SecureFields), Pagination (page state driven from
hit-tests), and Form (a GroupBox with label rows composed on top).
