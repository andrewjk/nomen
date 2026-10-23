# Handlers: owner-dispatched callbacks (design)

Documents the design for unifying event handling — click handlers first, but
the mechanism is Nomen's general callback story. For what ships today, see
GUI.md's "Click events"; for the closure machinery this builds on (capture
kinds, the capture-MOVES rule), see [CLOSURE.md](CLOSURE.md); for the
ownership rules underneath, see MEMORY.md.

## Implementation status

DESIGN — recorded 2026-10-20, out of the `#handle` / `Window.on_click` work
and a demo experiment that hit the wall this design removes.

**Stages 1–4 are implemented, plus the standard control-event family (2026-10-20/22).** Stage 1 (root desugar):
`.on_<event>(closure)` recognition, the hoist into hidden `#on_click_N`
methods, arm synthesis onto a default-empty `App.handle_events` (trait
default), `Window.run` routing through `app.handle_events(ref win)`, and the
no-parameters / no-upvalue / receiver-path checker rules; the window binding
list (`Window.on_click` / `ClickBinding` / `dispatch_clicks`) is retired,
and `was_clicked` is demoted from the documented pattern (it stays as the
low-level ring primitive). Stage 2 (host forwarding): non-root hosts —
structs with registrations the app owns, transitively — synthesize
`handle_events` too, pure-forwarding intermediates included; dispatch is
children-first, then own arms; the reachability rule admits any host on a
static field path from an App conformer (library composites are trusted and
exempt). `Pagination` internals are migrated off polls (the row registers
its own handlers in `#init`; the caller reads `page` — Form has no click
machinery to migrate). Stage 3 (id up-calls): a `ref Trait` parameter now
takes a conformer borrow — the instance's first word is its vtable, the
trait handle shape, so the up-call owner flows down as a plain pointer
(checker-only change; both backends already lowered it); `App` declares the
default-empty `run_handler(id, win)` protocol; a composite declares an
event by writing `func on_<event> = (ref self, int id)` plus a `tick` that
forwards the owner down, and the app-side `.on_<event>(closure)` hoists the
handler onto the app, synthesizes the `run_handler` override the composite's
`owner.run_handler(id, ref win)` callback hops into, and rewrites the site
to the enrollment call `receiver.on_<event>(N)`. `Pagination` grew the
first event API (`on_page_change` / `tick`) and the gallery consumes it.
Stage 4 (dynamic trees): a `List<Row>` field on the app is a DISPATCHABLE
host collection — the synthesized `handle_events` gains a dispatch loop
whose ELEMENT BORROW binds the slot, so each row's own arms run in place
and their state persists. The enabling language piece: `ref T x =
container.at(i)` is the sanctioned interior borrow — the site rewrites to
the library's `slot_ptr` primitive (a `ptr T` return is a bare machine
word in x0 on both backends) and the alias is policed by the ordinary
borrow-invalidation rules (any `ref self` call on the container kills it).
Tests: `test/gui/on_click.test.ts` (the todo Add
flow), `test/gui/composite_handlers.test.ts` (the MyPager composite — the
doc's example, working — plus the up-call flow),
`test/gui/dynamic_rows.test.ts` (`List<MyRow>` self-handling rows),
`test/gui/on_click_errors.test.ts` (every checker
rule plus the reachable-composite, transitive-chain, and up-call
acceptances); the demos are migrated (todo Add; the gallery's radio pair,
dialog buttons, and pagination — `demos_check.test.ts` keeps them green).

The control-event family grew past clicks (2026-10-22): `on_focus` /
`on_blur` drain a per-window first-responder snapshot (polled once per
frame by the run loop itself — `nomen_window_focus_poll` in `Window.run`;
a handoff fires the old control's blur and the new control's focus in the
same frame, and the field editor maps back to the editing control), and
`on_input` fires per text change (per-handle last-seen-text compares over
the live `stringValue`). All control events dispatch through ONE App
method (`handle_events`) — new events are new library drain methods
(`take_<event>` per control) plus their native plumbing; the App contract
and the route are fixed, and there is no compiler event table.

`on_right_click` joined the family (2026-10-23) as the first WINDOW-level
event: the record is the pump's click-kind stamp (`Window.nm`'s
`nomen_last_click_kind`, stamped by every `process_events` call — the same
edge `FrameEvents.click` reports as 2), and `Container.take_right_click`
is the drain. One edge per pump — not per control — so every registered
arm sees it (broadcast, no consumption handshake: a quiet pump stamps 0,
so the edge expires with the frame), and the HANDLER disambiguates: the
click comes through the dispatch window (`win.click_x()`/`click_y()`),
`content_click` translates for scrollable-hosted children, and
`Container.contains` hit-tests. The todo demo's right-click delete moved
off `App.frame` onto it (the demo now overrides only `start`;
`remove_todo_at` carries the hit-test). The v1 closure rules held — no
checker changes: the drain returns plain bool and the payload rides the
existing `win` parameter.

The exhaustive input tier landed the same day, on the same pattern —
no checker changes, new library drains + pump plumbing only:

- **`on_mouse_down`** (`Container.take_mouse_down`) — EVERY mouse-down
  (left, right, middle, mouse 4+), the AppKit click count, and the
  device-independent modifier flags. The pump stamps the full record
  (`nomen_last_click_button/count/modifiers` — other-mouse-downs were
  previously pumped and DROPPED), and the handlers read it through the
  dispatch window (`win.mouse_button()` 1-based, `mouse_click_count()`,
  `mouse_modifiers()`, plus the existing `click_x()`/`click_y()`).
  `on_right_click` is now honestly framed as this tier sugared for
  button 2; `FrameEvents` carries the same record
  (`mouse_button`/`mouse_click_count`/`mouse_modifiers`) for the `frame`
  form.
- **`on_scroll`** (`Scrollable.take_scroll`) — scroll-wheel deltas
  accumulated across each pump's events (trackpad batches, momentum),
  read via `win.scroll_dx()`/`scroll_dy()`; `FrameEvents.scroll_dx`/
  `scroll_dy` for the frame form. Continuous input, its own family: the
  edge means "this frame scrolled", the magnitudes are the payload.

The test seam generalizes: synthetic events posted into NSApp's queue via
`postEvent:atStart:` deliver deterministically on the next pump. One
lesson recorded — the classic `NSEvent` mouse factory has NO buttonNumber
parameter (it reads 0), so non-left/right buttons must be synthesized
through `CGEventCreateMouseEvent` + `NSEvent.eventWithCGEvent:`
(test/gui/mouse_input.test.ts covers middle+Command+double-click and a
5-line scroll).

Still to land: the deprecation-cycle doc sweep (the poll examples leave
GUI.md's other sections), and the `List<Own>.at()` uniform-borrow load
question (below — the element BORROW is landed; the owning-copy `.at()`
read remains as recorded).

## The problem: two click forms, and the wall behind them

Click handling today has two user-facing forms that live in two places, and
the user has to know which to reach for:

- **Polls** — `if self.btn.was_clicked() { ... }` inside `App.frame`.
  Edge-triggered per control; works for any handler because `frame` holds
  `ref self`.
- **Registered closures** — `win.on_click(handle, func () { ... })`, wired in
  `start`; each frame `dispatch_clicks` drains the shared native click ring
  against the bindings before the app frame.

The closure form exists because `#handle` view twins are copyable
(CLOSURE.md's capture rules: a twin capture is a plain data copy, so the
capture-MOVES rule never fires). But that is also its ceiling: the closure can
touch sibling CONTROLS and nothing else. The moment a handler needs app state
— read a text field, mutate a list, call a `ref self` method — it cannot be a
closure, and the author falls back to a poll in a different method. The two
forms also interact: a record consumed by a binding never reaches a poll
(first consumer wins), so registering `on_click` on a control silently
starves its `was_clicked` poll.

The motivating experiment — the natural code a user writes first, from the
todo demo:

```
var add_btn = Button(window, "Add")
add_btn.on_click(func() {
	var string new_text = self.input.get_text()
	if new_text != "" {
		self.add_item(new_text)
		self.input.set_text("")
		self.redance(ref win)
		self.scroll.scroll_to_bottom()
	}
})
```

This fails on three stacked walls:

1. **No route**: there is no `on_click` member on a control. Registration
   lives on the `Window` (the binding list and the drain live there), and a
   control has no back-reference to its window — `mv struct Button` carries
   only `var uint64 handle`.
2. **Capture-MOVES**: the closure references `self` — an `mv struct` app,
   which a capture MOVES into the closure env (CLOSURE.md, "Move-only
   capturing values"). After that, `frame` and every other handler could not
   touch the app. `win` is a borrow, and borrows are not capturable at all.
3. **Lifetime**: even if capture were allowed, the app MOVES after `#init`
   (locals → fields, then `win.run(mv app)`). Anything captured at
   registration names the old storage.

## The insight: the closure becomes a method; the owner lends the borrow at dispatch

The three walls share one root: the closure tries to _carry_ state it should
_borrow at dispatch_. The fix is to stop treating the closure as a value and
treat it as **a method of the enclosing struct that the framework invokes**:

- The closure body is **hoisted** into a hidden method on the enclosing
  struct — `#on_click_1 = (ref self, ref Window win) { body }`. Hidden
  methods are ordinary methods: every existing borrow rule already applies to
  their bodies, and both backends already lower them. No new codegen.
- The registration site emits **no code at all**. It is checked into a
  dispatch **arm** — `if handle == self.add_btn.handle { #on_click_1(ref
self, ref win) }` — whose handle expression re-evaluates at dispatch,
  against final fields. Staleness (wall 3) dissolves because nothing was
  captured; only the _path_ is remembered.
- The borrow of `self` is taken **by the dispatcher, at dispatch time**, by
  whoever owns the host — for the app, the `run` loop, which holds the app
  for its whole lifetime. Wall 2 dissolves because the closure captures
  nothing; `self` inside the body is the hidden method's own receiver
  parameter.

This is the same shape the language already uses for `App.frame`: the
framework holds the object and calls trait methods on it per frame. The
desugar just lets the user _write_ the callback as a closure while _getting_
a method.

## The mechanism

### Registration

```
self.add_btn.on_click(func () {
	var string new_text = self.input.get_text()
	if new_text != "" {
		self.add_item(new_text)
		self.input.set_text("")
		self.redance(ref win)
		self.scroll.scroll_to_bottom()
	}
})
```

`.on_<event>(closure)` is checker-interpreted (the name-keyed precedent is
the `Fiber.start_on` rewrite): no code executes at a registration site.
Routing is by precedence:

1. **Declared event API** — the receiver declares
   `func on_<event> = (ref self, int id)`: the composite owns the event
   source and drains it; the site rewrites to the enrollment call. This is
   the framework-author extension point — any widget, any event name, GUI
   or not (`on_command` on a voice-only widget) — and it wins over the
   builtin drains even on a Control-conforming composite.
2. **Control drain** (naming convention, no table) — `on_<event>` routes to
   the control's own `take_<event>` drain method (`Button.take_click`,
   `TextBox.take_input`, …): the control DECLARES which events it emits, in
   the library, next to its native plumbing. No compiler table, no
   privileged events; a new event kind is new library methods, and a
   control that doesn't emit an event says so at the registration
   ("'Button' doesn't emit on_hover events").
3. **Otherwise** — ordinary resolution: a same-named method on a
   non-control resolves as a call; a missing one is "Function not found".

### Hosts and dispatch

A struct with registrations is a **handler host**. The checker synthesizes on
it:

```
func handle_events = (ref self, ref Window win) {
	// first call only: arm registered non-button views
	//   (nomen_window_clicks_init per arm — buttons already arm
	//   target/action in their constructors)
	// drain own arms, in registration order:
	if nomen_control_take_click(self.add_btn.handle) { #on_click_1(ref self, ref win) }
	// forward to child hosts, depth-first:
	self.some_field.handle_events(ref win)
}
```

`App` grows a default-empty trait method `handle_events` (trait defaults have
precedent: `Enumerable.length`); a conformer with registrations gets the
synthesized override. `Window.run` calls `app.handle_events(ref self)` each
frame before `frame` — the same slot `dispatch_clicks` occupies today. Trait
calls through `mv App` parameters are existing machinery (the `Enumerable`
tier): **zero backend changes**.

`FrameEvents.click` / `click_x` / `click_y` are unchanged — right-clicks
dispatch through `on_right_click` (below), and the frame fields remain for
coordinate-driven input that no event names (drag positions, hover
tracking) and manual loops.

### Checker rules

Each is one clear error:

- **Receiver must be a `self`-rooted field path** — `self.add_btn.on_click(...)`:
  the arm re-evaluates the path at dispatch, so a local receiver
  (`add_btn.on_click`) has nothing to re-evaluate. Error teaches the field
  form.
- **The closure takes no parameters** (v1). The body's context is `self` and
  the dispatch window `win`.
- **No upvalue captures (v1)** — the hoisted method has no env. A body
  referencing an outer local errors with "handler closures see `self` and
  the dispatch `win` — copy what you need into fields."
- **Host reachability** — the enclosing struct must conform to `App` or be a
  (transitive) field of one: dispatch reaches hosts through static field
  paths from the run root. A host the root cannot reach is rejected ("handlers
  dispatch from the run root — 'MyPager' is not owned by the app").

### What retires

- `Window.on_click(handle, closure)` and the `ClickBinding` /
  `clicks` / `dispatch_clicks` machinery — the twin-capture form is
  subsumed (the radio pair's handler body becomes `self.radio_b.set_checked(false)`
  — no twins minted for handlers at all).
- `was_clicked()` as the _documented_ pattern. It stays as the low-level ring
  primitive (the desugar's drain lowers to it) — during migration the
  coexistence is safe because arms drain their own registered handles and
  never drain-any. After migration the first-consumer-wins footgun is gone:
  every left-click record has exactly one consumer, its arm.

## Handler hosts beyond the root: user-authored composites

Keying on `App` would only cover controls the library ships. The desugar
keys on **handler-host** instead — any struct with registrations — and the
app's dispatch forwards to host-typed fields. A user's composite is written
exactly like a library control:

```
mv struct MyPager : Control {
	var Button prev
	var Button next
	var int page = 0

	pub func #init = (self, Window window) {
		self.prev = Button(window, "<")
		self.next = Button(window, ">")
		self.prev.on_click(func () { self.page = self.page - 1 })
		self.next.on_click(func () { self.page = self.page + 1 })
	}
}
```

Internal state transitions run with `ref self` = the composite, borrowed by
the forwarding chain from the run root. All field paths are static and
concrete, so forwarding is direct calls — no trait objects, no B5. Forward
order is children-first, then own arms (most specific first), deterministic.

## Upward notification (composite → app)

A composite whose change interests the app has three tiers:

1. **Value polling (v1)** — the app reads `self.my_pager.page` in `frame`.
   This is _state_ polling, not click polling; the gallery's status line
   already works this way for sliders and steppers.
2. **Id up-calls** — the composite stores an int per event; the app forwards
   itself down once per tick (`self.my_pager.tick(ref self, ref win)`, a
   trait-typed owner parameter — the same shape as `run`'s `mv App`), and the
   composite calls back `owner.run_handler(id, ref win)` — one vtable hop
   into the concrete app method the desugar synthesized. The borrow always
   flows _down_ per call; nothing is stored.
3. **B5 listener objects** — first-class handler values stored in fields
   (`mv PageChangeDelegate`), for handlers as composable runtime values. See
   the next section for why this is storage, not the borrow story.

## Soundness: what makes it work, and where it doesn't

The borrow is sound because dispatch happens at **points where the owner's
borrow is exclusive**: frame boundaries, poll points, loop iterations — under
Nomen's single-threaded cooperative scheduler. That precondition is also the
edge:

- **Truly concurrent dispatch is out.** A fiber running beside mid-mutation
  app state is a data race; spawn's move-semantics captures remain the
  correct tool there.
- **Callbacks that outlive the owner are out.** Handlers are methods, not
  objects: they cannot be sent to another thread, stored past the loop, or
  invoked after the owner dies. First-class handler _values_ are the B5
  storage tier — and even then, a stored object still cannot hold a borrow;
  dispatch-time borrows from the owner remain the only app-state path.
- **One-shot stateless callbacks don't need it.** Comparators and
  `map`/`filter` predicates are plain func values today; a stateful
  comparator would need the id/protocol chain per API and is not worth
  forcing into the pattern.

### Alternatives rejected

- **Escapable framework-held borrows** (store `{app*, method}` in the
  binding): needs a borrow that outlives its statement, tied to the window —
  borrow-checker machinery the hoist makes unnecessary. The registration
  stores no state, so there is nothing to keep alive.
- **`Rc`/`Weak` shared-mutable handlers**: against the ownership model; a
  different language.
- **Frame-events collapse** (clicks as data in `FrameEvents`, everything in
  `frame`): one place and zero machinery, but loses registration ergonomics
  and reintroduces handle-matching boilerplate. `FrameEvents` keeps the
  coordinate-driven cases it has today.
- **Polls-only** (arm every control, kill closures): simplest mental model,
  discards the twin-closure work and register-and-forget ergonomics.

## Beyond UIs

The general test: **a framework owns the loop, the user owns the state — the
pattern applies.** UI is consumer #1; the same three pieces serve:

- **Timers, animation, resize** — `on_resize` (the gallery's
  `layout_panes`), `win.every(500, ...)`: the run loop is already the
  dispatcher.
- **Event-driven IO** — ASYNC.md's Phase 4 io_uring runtime is
  completion-based, i.e. callbacks; completions dispatched at frame/poll
  boundaries are exactly host dispatch. A future Tcp/Http server framework
  (`server.on_route("GET /users", func () { ... self.db ... })`) is the same
  shape — the accept loop as dispatcher, the Node-model that cooperative
  fibers already resemble.
- **User-authored frameworks** — parsers (SAX-style events), state machines,
  protocol handlers, command dispatchers: any library needing call-backs into
  user state gets the ownership-clean form instead of edge-triggered getters.

The meta-payoff: this establishes **"closures with an owner-provided
receiver"** as Nomen's general callback mechanism, so callback ergonomics
never require escapable borrows, `Rc`/`Weak`, or runtime-checked shared
mutability. The ownership model stays pure; the power comes from dispatch
discipline.

## Relationship to B5 (trait-typed fields)

Two different walls, often conflated:

| Wall                                                                 | What breaks it                                       | Status                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| **Borrow** (handler can't hold app state)                            | Dispatch-time borrow from the owner — protocol calls | Exists (trait params: `run`'s `mv App`)                            |
| **Routing** (non-root hosts, composites)                             | Host forwarding down static field paths              | Checker synthesis, no B5                                           |
| **Storage** (handlers as first-class values; heterogeneous children) | **B5** — `mv ClickHandler` fields, `List<Control>`   | Recorded tranche (FOLLOWUP.md, "Trait-typed FIELDS on mv structs") |

B5 is storage-shaped, not borrow-shaped: a stored handler object still cannot
hold a borrow of the app. What B5 genuinely adds here is **dynamic trees of
self-handling controls** — `List<MyRow>` where each row carries its own
closures — because forwarding is static field-path recursion, and dispatch
through erased, runtime-sized elements is vtable-per-element. That intersects
the `List<Own>.at()` element-materialization questions recorded in
FOLLOWUP.md, and is the motivating GUI case to add to the B5 entry.

## Staging

- **Stage 1 — root desugar.** Checker: `.on_<event>(closure)` recognition,
  hoist, arms, no-upvalue and receiver-path rules, host reachability. App
  trait default `handle_events`; `Window.run` routing; retire the window
  binding list; demote `was_clicked` from the documented pattern. Tests: port
  `test/gui/on_click.test.ts` (the todo Add flow becomes the runtime test —
  the snippet that failed above, working); error tests for each checker rule.
- **Stage 2 — host forwarding.** Transitive host detection, forwarding
  synthesis, child-first ordering; migrate `Pagination`/`Form` internals off
  polls; a user-composite test (`MyPager`).
- **Stage 3 — id up-calls.** `App.run_handler` protocol; trait-typed ref
  params (representable — the vtable receiver is that shape); composite event
  APIs (`MyPager.on_page_change(...)`).
- **Stage 4 — B5 dynamic trees.** Pointer to the B5 tranche; `List<MyRow>`
  self-handling rows.

Deprecation cycle: one release with both forms documented as
"on_click is the way"; then the poll examples leave GUI.md and the demo(s)
migrate (the todo Add handler becomes the Stage 1 runtime test; the radio
pair loses its twins).

## Open questions

- **Arming cost**: lazy first-dispatch arming arms every registered non-button
  view on the first frame; controls that are never dispatched (no host) never
  arm. Alternative — arm in control constructors unconditionally — costs a
  recognizer per view. Decide with a large-UI benchmark.
- **Payload-carrying events** (menu/toolbar item index, key events): the
  hoisted signature generalizes to `(ref self, ref Window win, <payload>)` —
  stage 3+.
- **Manual loops** (headless tests drive `process_events` directly): expose
  the host's pump for tests, or keep a thin window-level helper.
- **Multiple windows**: one run root per window; hosts are per-root. An app
  hosting two windows forwards from whichever root it registers with —
  mechanical, but the doc follows GUI.md's single-window model until needed.
