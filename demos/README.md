# Nomen Demos

## Todo

A GUI app with a todo list. The list is unbounded: each todo creates its
own checkbox when added (Add button), and right-clicking a todo deletes
it — the grid node is removed and the control is freed by moving it into
a nested block, whose closing brace runs the checkbox's `#destroy`. The
input field's hint text is a real placeholder (`TextBox.set_placeholder`),
so the field reads empty until the user types.

## Async

A GUI app that fetches five letters (A-E) in parallel. The Fetch button
starts a coordinator fiber whose `async { }` nursery spawns five threads —
each sleeps a random 1-10 s (via `Random`), then reports its letter down a
`Channel`. The letters therefore arrive in **completion order**, so each run
prints a different order, e.g. `Done! B E D A C`. The label flips to
"Fetching..." immediately; the event loop stays responsive by polling the
coordinator's `Task.is_done()` instead of blocking.

## Controls

A gallery of every `System::Controls` control in one window — inputs
(TextBox, SecureField, SearchField, TextView), choices (CheckBox, Radio,
Switch, Toggle, Segmented, Select, Stepper, Slider), display (Progress,
Spinner, LevelIndicator, ImageView, DatePicker, ColorPicker), actions
(Button + Tooltip), and grouping (Separator, GroupBox) — laid out in a
2-column grid. Continuous controls are polled every frame into a status
line that only rewrites when the string changes. The modals are created up
front and driven from the manual event loop: Alert (blocks in NSAlert's own
modal loop and reports the button pressed), Sheet (its content window is
its own layout root, hit-tested in sheet coordinates while presented), and
Popover (toggled from an anchor button). A Scrolling section hosts a tall
label stack on a Scrollable's document view — measured unbounded, sized via
`set_content_size`, laid out into that height, with the scroll offset
polled into the status line.
