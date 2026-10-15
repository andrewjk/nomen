# GUI Component Plan

A roadmap for growing `core/System/Controls` from the current six controls
into a fuller toolkit, using [gpui-kit](https://gpui-kit.com/component/) as
the coverage checklist.

One framing note up front: gpui-kit's components are **custom-drawn** (Rust +
GPU, no platform widgets). They are useful to us as a _checklist of what a UI
toolkit needs_ and as a UX/interaction reference — not as an implementation
guide. Every Nomen control wraps a **native platform control** (AppKit on
macOS, UIKit on iOS), so the plan below triages gpui-kit's inventory by
whether a native backing exists and how much plumbing it needs, not by
visual fidelity.

## Current inventory (`core/System/Controls/`)

| Control     | Backing                           | Notes                                                        |
| ----------- | --------------------------------- | ------------------------------------------------------------ |
| `Window`    | NSWindow / UIWindow               | manual event loop (`process_events`), click coords           |
| `Text`      | NSTextField (label) / UILabel     | static text                                                  |
| `TextBox`   | NSTextField / UITextField         | single line, placeholder, get/set text                       |
| `CheckBox`  | NSButton (switch type) / UISwitch | toggle + title                                               |
| `Button`    | NSButton / UIButton               | momentary push                                               |
| `Container` | — (pure math)                     | Grid / VStack / HStack / ZStack / Block, dirty-rect relayout |

All controls follow one shape (see `CheckBox.nm` for the template):

```
pub mv struct X : Control {
	var uint64 handle = 0
	pub func #init = (self, Window window) { … }   // alloc + addSubview
	pub func set_frame = (ref self, int x, int y, int w, int h) { … }
	// value APIs (set_text, is_checked, …)
	// Control trait conformance: measure / set_frame / intrinsic_size
	func #destroy = () { … }                        // removeFromSuperview + release
}
```

Each function body carries up to four raw blocks: `#arch: c` and
`#arch: aarch64_use_c`, each for `#platform: macos` and `#platform: ios`.
macOS-first is fine; an iOS block can lag (the todo demo is macOS-only today).

Event handling stays with the manual loop for now: clicks arrive via
`Window.process_events` (1 = left, 2 = right) + `Container.contains`
hit-testing, and control _values_ are polled (`is_checked`, `get_text`, …).
Continuous controls (slider, progress) read their value each frame.

## Tier 1 — now (thin wrappers over system controls)

Ordered by (value ÷ effort). Each is one `.nm` file following the template
above; most are a `#init`, a couple of value setters/getters, and `#destroy`.

| #   | Component                   | Backing (macOS / iOS)                                    | gpui-kit analog         | Notes                                                                                                                                 |
| --- | --------------------------- | -------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Switch` ✅                 | NSSwitch / UISwitch                                      | switch                  | The missing "settings toggle". Pairs with CheckBox (check = task state, switch = preference).                                         |
| 2   | `Slider` ✅                 | NSSlider / UISlider                                      | slider                  | `min`/`max`/`value`; poll per frame.                                                                                                  |
| 3   | `Progress` ✅               | NSProgressIndicator (bar) / UIProgressView               | progress                | Determinate + indeterminate flag.                                                                                                     |
| 4   | `Spinner` ✅                | NSProgressIndicator (spinning) / UIActivityIndicatorView | spinner                 | Same control as #3 on macOS, different style; separate file on iOS.                                                                   |
| 5   | `Radio` ✅                  | NSButton (radio type) / — (iOS: composition)             | radio                   | Group semantics = Nomen-level (first-selected-wins list); control is a CheckBox sibling. iOS defers to Segmented or a checkmark list. |
| 6   | `Toggle` ✅                 | NSButton (push-on/push-off) / UIButton selected          | toggle                  | A Button variant — could also be a `kind` on `Button`.                                                                                |
| 7   | `SecureField` ✅            | NSSecureTextField / `secureTextEntry`                    | (input variant)         | Passwords. No real apps without it.                                                                                                   |
| 8   | `SearchField` ✅            | NSSearchField / UISearchTextField                        | (input variant)         | Cancel button + placeholder for free.                                                                                                 |
| 9   | `Select` ✅                 | NSPopUpButton / — (iOS later)                            | select                  | macOS first: add/remove items, `selected_index()`. iOS needs a picker or action sheet — defer its iOS block.                          |
| 10  | `Segmented` ✅              | NSSegmentedControl / UISegmentedControl                  | (select variant)        | `selected_index()`/`set_selected`.                                                                                                    |
| 11  | `Stepper` ✅                | NSStepper / UIStepper                                    | number-input            | Pair with a TextBox for the gpui-kit "number input" composition.                                                                      |
| 12  | `TextView` ✅               | NSTextView / UITextView                                  | textarea                | Multiline editing; intrinsic sizing differs from TextField — needs a `measure` that reports the flicked height or fixed rows.         |
| 13  | `ImageView` ✅              | NSImageView / UIImageView                                | image                   | File-path or named-system-symbol first.                                                                                               |
| 14  | `DatePicker` ✅             | NSDatePicker / UIDatePicker                              | date-picker, time-field | Use the calendar/clock styles; a browsable calendar _grid_ is Tier 3.                                                                 |
| 15  | `ColorPicker` ✅            | NSColorWell / UIColorWell (iOS 14+)                      | color-picker            |                                                                                                                                       |
| 16  | `LevelIndicator` ✅         | NSLevelIndicator / —                                     | rating                  | macOS-only (star/capacity/rating display).                                                                                            |
| 17  | `Separator` + `GroupBox` ✅ | NSBox (horizontal separator / bordered box) / —          | separator, group-box    | Two trivial files, macOS-first. GroupBox gives forms a labeled border for free.                                                       |
| 18  | `Tooltip` ✅                | `view.toolTip` / —                                       | tooltip                 | Not a control — one method on the base pattern (or a helper taking a handle + text).                                                  |
| 19  | `Alert` ✅                  | NSAlert / UIAlertController                              | alert-dialog, dialog    | Window-coordinated (runModal / present). Blocks; fine with the manual loop since NSAlert runs its own modal loop.                     |
| 20  | `Sheet` ✅                  | `beginSheet:` / UISheetPresentationController            | sheet                   | Hosts arbitrary controls in a sheet's content view — the contentView is just another layout root.                                     |
| 21  | `Popover` ✅                | NSPopover / UIPopoverPresentationController              | popover                 | Same "another layout root" trick, anchored to a handle.                                                                               |

Radio/Toggle/SecureField/SearchField are gpui-kit "input variants" rather
than standalone components — in Nomen they land as separate controls because
their native classes are separate (`NSSecureTextField` is not
`NSTextField`).

## Tier 2 — later (native, but real plumbing)

Still system-backed; each needs design work beyond the template before
coding.

| Component        | Backing                             | gpui-kit analog       | Why later                                                                                                                                                                                                                                                                   |
| ---------------- | ----------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Scrollable` ✅  | NSScrollView / UIScrollView         | scrollable            | **Highest value in this tier** — the todo app already outgrows 500px. A scroll container changes the layout engine's coordinate story (document view vs content view, y-flip, content size reporting from measure). Deserves a short design note in GUI.md before the code. |
| `Tabs` ✅        | NSTabView / UITabBarController      | tabs                  | Container-of-pages; page switching + the tab bar need to interact with our relayout.                                                                                                                                                                                        |
| `List` ✅ / `Table` | NSTableView / UITableView         | list, data-table      | Needs a data-source bridge (row count/value callbacks from Nomen) and row reuse. Big but native. The single-column List bridges via C globals polled like every value; the multi-column Table with view-based (reusable) cells is still open.                               |
| `ComboBox`       | NSComboBox / —                      | combobox              | macOS-only; editable + completing.                                                                                                                                                                                                                                          |
| `Menu` (context) | NSMenu (`view.menu`) / UIMenu       | menu, dropdown-button | Attach-a-menu is easy on macOS; iOS presentation differs.                                                                                                                                                                                                                   |
| `Toolbar`        | NSToolbar / —                       | toolbar               | Delegate-driven item model; macOS-only.                                                                                                                                                                                                                                     |
| `SplitView`      | NSSplitView / UISplitViewController | resizable, sidebar    | Resizable panes — the autoresizing-mask story overlaps ours.                                                                                                                                                                                                                |
| `OutlineView`    | NSOutlineView / —                   | tree                  | Tree-shaped data source bridge (same work as Table, plus hierarchy).                                                                                                                                                                                                        |

## Tier 3 — deferred (no system component; needs custom drawing)

gpui-kit has these because it draws everything itself. Until Controls grows a
custom-drawing story (a plain `Canvas`/`NSView` subclass with a Nomen draw
callback, or attributed-string views), these stay out:

badge, tag, avatar, kbd, skeleton, shimmer, alert _banners_ (in-app toast
variants — distinct from system `Alert`), accordion/collapsible,
carousel, chart/plot, diff, editor (code editing), calendar _grid_,
virtual-list, command palette, dock, status-bar, sidebar (custom), bubble/
message/questionnaire (chat composition), theme/root (global state).

Some Tier 3 items become reachable earlier as **pure Nomen composition** over
Tier 1 controls (no new natives, no drawing): number-input = TextBox + Stepper;
form = GroupBox + rows of Label+control; otp-input = five SecureFields;
pagination = Button row. Worth doing opportunistically once Tier 1 lands.

## Suggested execution order

1. Switch, Slider, Progress, Spinner — four trivial files; proves the
   template generalizes beyond the first three controls.
2. Radio, Toggle — CheckBox/Button siblings.
3. SecureField, SearchField — the input family completes.
4. Select, Segmented, Stepper — choice controls (macOS-first iOS blocks).
5. TextView, ImageView — content controls.
6. DatePicker, ColorPicker, LevelIndicator, Separator/GroupBox, Tooltip —
   the long tail of easy natives.
7. Alert, Sheet, Popover — modals/popups; window coordination.
8. **Pull `Scrollable` forward here** (top of Tier 2) — after Tier 1, the
   next blocker for real apps is scrolling, not more controls.
9. Tier 2 remainder in table order.

Along the way, extend `demos/` with a **gallery demo** (done —
`demos/controls/`, one window, a 2-column grid of sections, one per
control; the todo demo stays the end-to-end app). Every new control should
land with: the `.nm` file, a gallery section, and a demos/README.md blurb
line.

## Cross-cutting follow-ups (tracked as they bite)

- **Change notifications.** Polling works for the manual loop, but a
  `set_changed_callback` per control (or a single event-channel) will be
  needed the moment a control must react to the user between frames.
- **Enable/disable + font/appearance** — one-liners per control
  (`setEnabled:`, `setFont:`); add per-control when first needed rather than
  up front.
- **iOS parity.** The demo is macOS-only; several Tier 1 iOS blocks
  (Select, Separator/GroupBox, LevelIndicator, Tooltip) are intentionally
  deferred — keep the `#platform: ios` blocks as `// TODO` stubs in the same
  file so the gap is visible.
- **Focus & first responder.** Text controls fight over first responder;
  TextBox already tolerates this. Revisit when TextView lands (multiline
  field editor behavior differs).
