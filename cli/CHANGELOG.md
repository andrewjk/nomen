# Changelog

























## 0.8.0
<sub>2026-10-23</sub>

-  *(minor)*
  Window.run: the App contract — the framework owns the event loop, resize relayout, and teardown (App trait + FrameEvents); Window.set_content/close; Container.set_document
-  *(minor)*
  Native click events: button-family controls arm target/action at construction and was_clicked drains the edge per control — no coordinates, no hit-testing, works inside Scrollables
-  *(minor)*
  Window.on_click/dispatch_clicks: registered click handlers over #handle view twins (ClickBinding list, per-frame drain before the app frame, gesture-recognizer arming for non-button views); fix use_c ctor companion dropping container-ctor field defaults and generic field member types (aarch64); fix a borrow copy's func-field dispose freeing a shared closure descriptor (both backends); seed the clicks list in the raw content_window fabricators
-  *(minor)*
  Handler desugar Stage 1: control .on_click closures hoist to hidden methods on the app and dispatch through a synthesized handle_clicks before frame — app-state handlers without captures; Window.on_click binding list retired
-  *(minor)*
  Handler desugar Stage 2: user composites the app owns are handler hosts — dispatch forwards down static field paths (children-first); Pagination self-drives via its own on_click arms, poll accessors retired
-  *(minor)*
  Handler desugar Stage 3: id up-calls — ref Trait params take conformer borrows, App gains the run_handler protocol, composites declare event APIs (on_page_change/tick; Pagination ships the first)
-  *(minor)*
  Handler desugar Stage 4: dynamic trees — List<MyRow> fields dispatch per element through the element borrow (ref T x = list.at(i) lowered to slot_ptr); ptr T returns are bare words in x0
-  *(minor)*
  Control events beyond clicks: on_focus / on_blur (first-responder snapshot edges) and on_input (per-text-change), each with its own synthesized dispatcher and App trait default

  Also: event-routing precedence — a declared event API (`on_<event>(id)` on the widget) wins over the builtin table on any receiver, so Control-conforming composites and non-GUI (voice-only) widgets define their own events without touching the compiler's event table.
-  *(minor)*
  Single event pump: all control events (click/focus/blur/input and future ones) dispatch through one App.handle_events slot — the App contract is fixed as events are added
-  *(minor)*
  Events are library-defined: on_<event> routes to the control's own take_<event> drain method (no compiler event table); window refreshes the focus snapshot per frame
-  *(minor)*
  on_right_click: window-level right-click handlers (Container.take_right_click drain, pump click-kind stamp); todo demo's right-click delete moves off App.frame
-  *(minor)*
  Mouse events: on_mouse_down (every button + click count + modifiers via win.mouse_button/mouse_click_count/mouse_modifiers), on_scroll (accumulated deltas via win.scroll_dx/scroll_dy), FrameEvents full mouse record; pump no longer drops other-mouse-downs
-  *(minor)*
  Keyboard events: on_key_down/on_key_up (keycode + modifiers + auto-repeat via win.key_code/key_modifiers/key_repeat/key_up_code), FrameEvents full input record; pump no longer drops other-mouse-downs or key events
-  *(minor)*
  Window lifecycle + move events: on_mouse_move (pointer position via win.mouse_x/mouse_y), on_resize (content rect via win.resize_width/resize_height), close_requested interception (win.close() forced bypass), FrameEvents pointer position + dt; run arms setAcceptsMouseMovedEvents
-  *(minor)*
  on_select on all seven selection-bearing controls (Select/Segmented/ComboBox/Tabs/ListView/Table/OutlineView — shared selection ring, take_select drains, payload via the existing selected_index/selected_row), and synthesized composite tick forwards (the desugar appends the per-frame owner forward to the app's dispatch pump)
-  *(minor)*
  SplitView holds divider positions across re-frames (a shared delegate) — set_position pins once and resizes stop re-dividing the panes
-  *(minor)*
  Menu/Toolbar on_item_select handlers — item picks dispatch as registered events (take_item_select drains + selected_item payload getter); clicked_item polls remain for manual loops
-  *(minor)*
  Registered pane roots (Container.set_pane + the Window.relayout pane pass) — tab/split pane grids re-lay with the run loop: apps register, the framework lays
-  *(minor)*
  on_double_click — the list-row "open" gesture as a registered event (the sugar over the mouse-down record: left button, click count 2; window-level broadcast, position via the dispatch window)
-  *(minor)*
  on_submit — Return-in-a-field as a registered event on TextBox/SecureField/SearchField (NSTextField target/action armed per constructor, a per-handle submit ring, committed text via the existing get_text)
-  *(patch)*
  Nested mv struct fields of container elements load as independent deep copies (the auto-derive copy gate now accepts Buffer/Map/Set fields)
-  *(patch)*
  Map/Set gain .copy(); container-element Map/Set fields load as independent deep copies; fixes the aarch64 deferred zero-arg variadic-init marshalling behind Map.copy
-  *(patch)* - Make structs with 'view' fields only usable in the current scope
-  *(patch)* - Always check declaration-level return types
-  *(patch)*
  Assigning to a ref alias re-points the alias itself: the assignment is adopted into the alias's own slot (an owning var, freed at scope exit) and the previously-aliased instance stays owned by its owner
-  *(patch)* - The freeze write-gate names the spawn that lent the donor ("'xs' is borrowed by the 'worker' spawn …")
-  *(patch)* - aarch64: deep-copy enum-with-data fields of container elements on mv load (stale free)
-  *(patch)* - Fix the internal 'Unknown value: _recv_N' check error on a chained Box deref through an accessor result
-  *(patch)* - Enforce the mv spelling on generic struct templates whose instantiation owns heap (was silently derived per-mono)
-  *(patch)* - Fix destructuring markers dropped by per-mono body clones; variadic params are callee-owned (mutable)
-  *(patch)* - Map's variadic init uses an explicit mv-destructure transfer chain; retire the temp-rooted mv-arg exemption
-  *(patch)*
  Fixed-array struct elements: correct ctor copy stride + uniform-heap detach on both backends, per-element destroy walks (trait-declared owned fields reclaimed), valid C emission for array fields
-  *(patch)*
  Buffer primitives: mv store_T reclaims displaced owned state behind per-leaf identity guards; alloc destroys and frees the old slab before the exact-cap calloc (modify_T's container leak re-recorded — a guarded reclaim is unsound there)
-  *(patch)*
  Unbounded todo demo controls, TextBox.set_placeholder, right-click events, Container.remove_leaf, List.remove_at_or_panic, constant folding across conditional branches
-  *(patch)* - Controls: Switch (NSSwitch/UISwitch) — the settings toggle
-  *(patch)* - aarch64: ABI thunk bridges float params/returns into aarch64_use_c C bodies (x/d register files)
-  *(patch)* - Controls: Slider (NSSlider/UISlider) — min/max/value for the manual loop
-  *(patch)* - Controls: Progress (NSProgressIndicator bar/UIProgressView) — value 0..1 + indeterminate flag
-  *(patch)*
  Controls: Spinner (NSProgressIndicator spinning/UIActivityIndicatorView); aarch64 naked-inline loads sub-word fields at storage width
-  *(patch)* - Controls: Radio (NSButton radio type) — group semantics stay Nomen-level; iOS deferred
-  *(patch)* - Controls: Toggle (NSButton push-on-push-off/UIButton selected)
-  *(patch)* - Controls: SecureField (NSSecureTextField/UITextField secureTextEntry)
-  *(patch)* - Controls: SearchField (NSSearchField/UISearchTextField)
-  *(patch)* - Controls: Select (NSPopUpButton) — items + selected_index; iOS block deferred
-  *(patch)* - Controls: Segmented (NSSegmentedControl/UISegmentedControl)
-  *(patch)* - Controls: Stepper (NSStepper/UIStepper) — min/max/increment + polled value
-  *(patch)* - Controls: TextView (NSTextView/UITextView) — multiline editing
-  *(patch)* - Controls: ImageView (NSImageView/UIImageView) — file path + SF Symbol, has_image
-  *(patch)* - Controls: DatePicker (NSDatePicker/UIDatePicker) — epoch-seconds value API
-  *(patch)* - Controls: ColorPicker (NSColorWell/UIColorWell) — 0-255 rgb component API
-  *(patch)* - Controls: LevelIndicator (NSLevelIndicator, macOS-only); aarch64: Mach-O-safe companion symbols for L-prefixed labels
-  *(patch)* - Controls: Separator + GroupBox (NSBox separator/primary styles, macOS-first)
-  *(patch)* - Controls: Tooltip helpers (view.toolTip by handle) — set/get, macOS-first
-  *(patch)* - Controls: Alert (NSAlert) — title/message/buttons + blocking run(); iOS deferred
-  *(patch)* - Controls: Sheet (beginSheet:) — content_window() exposes the sheet as a layout root; iOS deferred
-  *(patch)* - Controls: Popover (NSPopover) — content sizing + anchor-to-handle show; iOS deferred
-  *(patch)* - Sheet: content_window retains the sheet window so the Window-shaped copy's destroy is balanced
-  *(patch)* - Controls: Scrollable (NSScrollView document view) — content_window layout root, offset polling; iOS deferred
-  *(patch)* - Controls: Tabs (NSTabView) — per-page content_window layout roots; iOS has no counterpart, deferred
-  *(patch)* - Controls: List (NSTableView, single column) — C-global data-source bridge, polled selection; iOS deferred
-  *(patch)* - Controls: ComboBox (NSComboBox, editable + completing) — macOS-only; iOS deferred
-  *(patch)* - Controls: Menu (NSMenu context menu) — attach-to-handle, edge-triggered clicked_item poll; iOS deferred
-  *(patch)* - Controls: Toolbar (NSToolbar delegate items) — labeled push buttons, edge-triggered click poll; macOS-only
-  *(patch)* - Controls: SplitView (NSSplitView panes as layout roots) — programmatic divider position; iOS deferred
-  *(patch)* - Controls: OutlineView (NSOutlineView tree bridge) — C-global node pool, NSNumber items; macOS-only
-  *(patch)* - Fix: displaced-destroy of a generic-typed var reassigned in a nested scope emitted the bare (unmono) destroy symbol
-  *(patch)* - Fix: aarch64 float-to-int cast converted stale d0 instead of materializing the bits in x0
-  *(patch)* - Controls: Table (NSTableView multi-column) — view-based reusable cells, row-major C-global cell grid; macOS-only
-  *(patch)* - Fix: aarch64 custom #init staged by-address struct params as the struct itself when passing them to nested ctors
-  *(patch)* - Controls: NumberInput composition (TextBox + Stepper, int hundredths)
-  *(patch)* - Controls: OtpInput composition (five SecureFields in a row)
-  *(patch)* - Controls: Pagination composition (prev/next + numbered Button row, clamped page state); Button set_hidden/is_hidden
-  *(patch)* - Controls: Form composition (GroupBox + label rows over a ZStack); gallery Composites section
-  *(patch)* - Fix: float field defaults pool a .double entry; ctor function_data flushes after ret (literals landed inline)
-  *(patch)* - Controls: composites use direct field ctors and NumberInput's float API (int-math text formatting)
-  *(patch)*
  Fix: per-body variable_types isolation for struct methods/inits (a float param inherited a view-string's type and mis-lowered to_string on both backends)
-  *(patch)* - Scrollable: content_click window-to-document translation (free function, tuple destructure) and scroll_to_bottom
-  *(patch)*
  Container: a grow leaf carries the matching autoresizing size bit so the flexible region resizes live during a window drag
-  *(patch)* - Fix: Window.set_frame sent setFrame: (an NSView selector) — NSWindow needs setFrame:display:
-  *(patch)*
  Fix: Scrollable scroll_to_top/bottom set the clip origin directly (scrollPoint/scrollRectToVisible get constrained short of the edges live)
-  *(patch)* - Fix: Scrollable clamps the document height up to the viewport so short content stays top-anchored
-  *(patch)*
  Fix: Window.process_events drains an autorelease pool per pump (the manual loop leaked tens of MB/s: unbounded autoreleased AppKit objects)
-  *(patch)* - aarch64: string interpolation of 8+ arguments (helper frame collision)
-  *(patch)* - aarch64: ref-scalar receiver passed &caller-storage instead of its value (ref param interpolation read garbage)
-  *(patch)* - Fix: conditional mv string transfer leaked the not-taken path's heap string
-  *(patch)* - Fix: TextBox iOS get_text sent a typo'd Objective-C selector
-  *(patch)* - Controls: page scrolls; Toolbar.set_label; Table cell fix; measure cache (resize shrink)
-  *(patch)*
  Fix: C-backend trait-boxing referenced the audit-only malloc wrapper, so trait-typed mv parameters failed to compile in non-audit builds
-  *(patch)*
  Reject mixed aarch64_use_c bodies at check time (find_use_c_mixed_body); move Container's handle-0 guards into every arch block; build_and_check_output asserts BuildResult.errors; asm validator accepts external branch targets in split user-TU builds
-  *(patch)* - Fix: receiver-relative field accesses beyond the aarch64 immediate ranges
-  *(patch)* - Fix: List<Own>.at() element reads of destroy-aliasing structs are pure borrows (double-release)
-  *(patch)*
  aarch64: use_c raw blocks nested in control flow are now a check + build error (were silently dropped from the companion); mixed use_c/Nomen bodies already errored, nested ones escaped the top-level scan

## 0.7.1
<sub>2026-10-12</sub>

-  *(patch)* - Fix: Box<T>(T(...)) builds in place, eliding the struct copy
-  *(patch)* - Fix: split return-save stp/ldp beyond the +504 scaled-offset range
-  *(patch)* - Fix: reject ownership transfers out of bare mv-struct params
-  *(patch)* - Fix: swap replacement builds into a temp, not the sret buffer
-  *(patch)* - Fix: heap-own string locals reassigned a literal conditionally
-  *(patch)* - Fix: Box fields on mv-container elements deep-copy on load, transfer on store
-  *(patch)* - Fix: conditional mv-struct move no longer leaks its string default
-  *(patch)* - Fix: conditional move no longer leaks on continue
-  *(patch)* - Fix: heap Array<T> temp reclaim on the return path (aarch64)
-  *(patch)* - Fix: conditional return of a local owning string leaks its heap (both backends)
-  *(patch)* - Fix: owned return discarded in a while post-statement leaks (both backends)

## 0.7.0
<sub>2026-10-10</sub>

**Language changes — migration notes.** The ownership model was rebuilt this release: classes are gone, ownership is declared on the type, and `string` participates. The entry points:

-  *(minor)*
  Breaking: the `class` keyword retires — `class X { ... }` is now a compile error naming the fix: declare `mv struct X` (single-owner, move-only). Spell sharing where it happens: `ref` aliases (`ref Box<Node> q = p` — both names see one instance, the owner defers its free), `Box<T>` for heap indirection, `Mutex`/`Atomic<T>` for cross-task mutation, `WeakHandle<T>` for back-pointers. `extend class` retires with it (`extend struct` only).
-  *(minor)*
  Breaking: ownership is declared, not inferred — a bare `struct` is Copyable and the checker verifies the claim (a `Box<T>`, `mv struct`, or `mv enum` field is rejected, with the fix named: mark the struct `mv struct` or drop the field). `mv struct` bindings MOVE: `var Config c2 = c` is an error — spell `mv Config c2 = c` to transfer (c is invalid afterwards) or `c.copy()` for a deep copy. The same verifier covers enums: a case payload typed a `mv struct` requires `mv enum`. Passing a `mv` value bare to a function is a read-only borrow; `mv` params transfer; `ref` params are mutable borrows the call site must acknowledge.
-  *(minor)*
  Breaking: `string` is an owning type — initializing/assigning from another string variable requires `mv` (transfer) or `.copy()` when the source outlives the binding, reading a `string` field (and `return self.field`) requires `.copy()`, and a `mv string` parameter requires `mv` at the call site. Adds `string.copy()` (literals stay exempt).
-  *(minor)*
  New: `Box<T>` — a single-owner pointer to a heap-allocated value, the cycle-breaking and stable-address shape. Boxing takes ownership (`Box<Node>(mv n)`), access through the box is transparent (`b.value`), `Box<T>?` is the natural null slot, and an inline containment cycle (`var Node next`) is a compile error naming `Box<Node>` as the fix.
-  *(minor)*
  New: trait objects box at every trait position — a trait-typed value (binding, array element, call argument; struct fields are still pending) is a heap-boxed handle on both backends; boxing takes ownership, and bare trait params take the box (T3 stack-copy convention).
-  *(minor)*
  New: `WeakHandle<T>` — a generation-validated weak handle for child→parent / delegate back-pointers. The tracked object must be owned elsewhere (fresh temporaries are rejected); `#destroy` invalidates every handle to it; `h.get()` returns the live pointer or `null` (bind to `T?` and nil-check).
-  *(minor)*
  New: `Atomic<T>` — lock-free protected 64-bit slots shared across tasks (`load`/`store`/`fetch_add`/`swap`, sequentially consistent). An `Atomic<T>` field is the sanctioned way to mutate a borrowed capture from another worker (the freeze exempts it).
-  *(minor)*
  Breaking: the task-boundary sharing model is spelled at the call site — `Sendable` auto-derivation is gone (opt in with `: Sendable`); scalars/strings/`Copyable` structs cross by copy, `mv` structs move (donor invalidated), and a `mv struct` or `view` passed bare inside an `async` block is a checked region borrow: the join at the closing brace bounds it, and the freeze forbids writing, moving out, or `ref self`-mutating the donor while tasks read it. `.detach()` accepts owned (`mv`) captures only; app-lifetime state is a root-scope global (exempt). Thread, Fiber, Task, Channel, Mutex, Tcp, Tester and Random are now `mv struct`s — they move instead of alias.
-  *(minor)*
  New: nested nullable lowerings — `Box<T>?` (and pointer-shaped handles) null to the pointer itself; inline `T?` (Copyable or `mv`) keeps the companion `_has` flag. Nothing boxes silently.
-  *(minor)* - Breaking: keyword renames — `owning struct/enum` → `mv struct/enum`, keyword `move` → `mv`
-  *(minor)* - Language: remove the unused reserved words `in` and `cp`
-  *(minor)* - Breaking: rename the `must_use` modifier to `checked` (`pub checked enum Result<T, E>`)
-  *(minor)* - Breaking: rename the `extern func` FFI modifier to `foreign func` (avoids the `extend` collision)
-  *(minor)* - Feat: bare nested block statements — a plain lexical scope whose mv values release at the closing brace (both backends)
-  *(minor)*
  Breaking: remove the Func<T, R> func-type alias — spell func types as 'func (params, out result)' (a parse error points at the new form)
-  *(minor)*
  Breaking: match/switch else arms move outside the case braces — 'match x { cases } else { ... }', consistent with if/else
-  *(minor)*
  Phase N tranche 2: R1 checked region borrows (owning structs + views at the task boundary), R3 freeze, sound spawn packing on both backends
-  *(minor)* - Phase N tranche 3: WeakHandle<T> (generation-validated registry, #weak construction hook, destroy invalidation)
-  *(minor)* - Phase N tranche 4: Atomic<T> protected slots, ref-arg spawn borrows, protected-slot freeze derivation
-  *(minor)* - Phase B tranche 1: owning struct/owning enum declared ownership + the Copyable verifier
-  *(minor)* - Phase B tranche 2: Box<T> (transparent boxed owning pointers, cycle detector, Box fields in structs)
-  *(minor)*
  Phase B tranche 3 (B4): trait objects box at every trait position — boxed handles on both backends, tier-1 demotion, boxing-takes-ownership rules (moves donors, rejects ref/view sources and trait-handle copies), the T3 stack-copy convention at bare Trait params, and dispatched destroy through the vtable shim.
-  *(minor)*
  Phase R tranche 1: the #spawn construction hook on owning structs (inline-value C construction, sret aarch64 helper) — the launch surface classes monopolize now reaches the value tier
-  *(minor)*
  Phase R tranche 2: Thread/Fiber/Task as owning structs (handle fields, inline nursery-spawn emission, value-self Awaitable.wait, owned-return reassignment + boxed moved-trait-arg fixes)
-  *(minor)*
  Phase R tranche 3: Channel/Mutex/Tcp/Tester/Random as owning structs (Sendable dropped, spawn region-borrows + global exemption, split-build WeakHandle fix, root-scope owning-struct globals)
-  *(minor)*
  Retire the class keyword: it now emits the retirement error and parses as an owning struct (STRUCT_PLAN_3 Phase R, the flip)
-  *(minor)*
  B1 full cutover: the Copyable verifier over the closed owning predicate (string fields make a struct owning), declared-ownership migration across core/ and the corpus, bare owning params are read-only const borrows (pbv shell retired), move-transfer rows on both backends
-  *(minor)*
  STRUCT_PLAN_3 phase B1 backend cutover: owning structs' string fields are uniformly heap (ctor strdup, owning stores strdup + displaced reclaim, scope-exit destroy frees unconditionally) on both backends; borrow-accessor bindings (.at/.first/.slice/.load/.at_or_panic/.get_or) strdup their copies; method string returns normalize to heap for vtable dispatch; move-base literals and recv carriers follow ownership
-  *(minor)*
  STRUCT_PLAN_3 D3 endgame: `string` is a declared owning type — bindings/assignments from another string variable require `move` or `.copy()`, string field reads and `return self.field` require `.copy()`, owning fields reject borrowed stores, `move string` parameters demand `move` at the call site, container stores transfer, and the silent last-use assign copy is retired. Adds the `string.copy()` method; literals remain exempt. String captures in lambdas stay backend snapshots with checker read-invalidation.
-  *(patch)* - Phase A: spelled ref class aliases; fix prefix-move transfer gap and aarch64 class transfer double-destroy
-  *(patch)*
  Phase N tranche 1: checked region borrows at the task boundary (root rule + detach owns its captures); fix root-scope class globals on both backends
-  *(patch)*
  Phase B tranche 4: owning structs own class-typed fields (var spelling, transfer-on-store, displaced reclaim, destroy on both backends), the field restrictions collapse into the Copyable verifier, and the nullable lowerings are pinned (Box<T>? null pointer, inline companion flag, nullable owning-struct return normalization)
-  *(patch)* - Fix generic construction without call-site type args linking the generic's init
-  *(patch)* - Fix aarch64 box member access on a call result
-  *(patch)* - Track nullable field/box bases for member access
-  *(patch)* - Fix aarch64 nursery join clobbering promoted registers
-  *(patch)* - Sweep vp check lint/type findings hidden behind the formatting gate
-  *(patch)* - Post-R cleanup: remove dead class-keyword plumbing; reword stale class diagnostics to owning-struct vocabulary
-  *(patch)*
  Backend fixes: aarch64 swap write-back struct-copy, ClassBuffer.modify move contract, nullable owning-field construction/displacement destroy fixes on both backends, capture_destroys recursion
-  *(patch)*
  Box transfer ownership: Box<T>(move x) drops donor string records (shallow copy takes ownership); generated Box destroy reclaims string-only pointees — fixes guarded .at() short-circuit reads through boxed elements
-  *(patch)* - Fix: 'move ... swap' on a string leaked at runtime
-  *(patch)* - Fix: trait-typed root-scope globals
-  *(patch)* - Fix: borrow-accessor carrier leaked deep-copied containers
-  *(patch)* - Fix aarch64 trait-handle re-boxing in a loop (SIGSEGV)
-  *(patch)* - Fix: aarch64 container destroy over-destroying empty cap slots
-  *(patch)* - Fix: box value-struct conformers into trait enum payloads
-  *(patch)* - Fix: box fresh-ctor trait enum payloads
-  *(patch)* - Fix: boxing a string-field conformer no longer leaks
-  *(patch)* - Fix: free trait-dispatched string returns
-  *(patch)* - Fix: trait-target string field writes are uniform-heap
-  *(patch)* - Fix: owning-struct func-field closure lifetime
-  *(patch)* - Fix: enum-case .copy() string args leak — hoist an owning _param temp (both backends)
-  *(patch)* - Fix: string? .copy() preserves null (null-guarded lowering, result typed string?)
-  *(patch)* - Fix: mv-from-untracked string donor leaked/stale-freed (C declare + assign paths)
-  *(patch)* - Fix: box trait-returning switch/match/if joins (both backends) + park box-copy source across malloc bl
-  *(patch)*
  Fix: trait-default bodies link — bind self/params on aarch64; scope C trait-body state; reclaim fieldless mv conformers' trait fields
-  *(patch)* - Fix: trait-field reassign on mixed conformer sets no longer frees rodata
-  *(patch)*
  Fix: nested trait-field conformers — custom-init seeds trait defaults (both backends); destroy predicate sees trait-declared state
-  *(patch)* - nomen test now lists discovered test files up front and streams each file's result the moment it finishes

## 0.6.13
<sub>2026-10-04</sub>

-  *(patch)*
  aarch64: call-bearing auto-inline unlocked (splice state-leak fixes: nir_site_allocs restore, dest-hint isolation); transitive splice cost model
-  *(patch)* - aarch64: NEON shifted-read vectorization (load_T(i+c), c>=1) with per-element event-order soundness rule
-  *(patch)*
  aarch64: NEON byte (.16b) element kinds — load_u8/store_u8 primitives + planner descriptor; index-temp class exemption for shifted reads
-  *(patch)*
  checker: shifted-bound discharge — path±int bound rendering, path-vs-path guard mirroring, transitive relaxation + path_bounds consultation
-  *(patch)*
  checker: variable-shift index discharge (load(j + d) vs j < n - d) with referenced-token invalidation; fix numeric-range transfer for shifted args
-  *(patch)*
  aarch64: frame-slot store-store kill (orphaned pending store drops when the slot's next block access is another store); pidigits -1-2.4%

## 0.6.12
<sub>2026-10-02</sub>

-  *(patch)* - Fix: moved-param teardown clobbered fat-string returns

## 0.6.11
<sub>2026-10-02</sub>

-  *(patch)* - Fix: nomen test loses records in parallel runs
-  *(patch)* - Fix: aarch64 force-heap borrow-init double free
-  *(patch)* - Fix: moved value-struct param teardown leak
-  *(patch)* - Fix: stale ownership flag in ctor field defaults

## 0.6.10
<sub>2026-10-02</sub>

-  *(patch)* - Cheapen aarch64 asm pipeline: shared lift, label maps, parse memo
-  *(patch)* - aarch64 displaced container-field reclaim + field-read borrow fixes
-  *(patch)* - per-test leak attribution in nomen test --audit
-  *(patch)* - explicit free_strings in aarch64 field destroys
-  *(patch)* - audit runtime: diagnose unmatched frees, mode-matched system object

## 0.6.9
<sub>2026-10-01</sub>

-  *(patch)* - parallel nomen test files
-  *(patch)* - StringBuilder.to_string resets len/cap so the builder is reusable
-  *(patch)* - Auto-discover audit_runtime.c for --audit (bundled fallback)
-  *(patch)* - Fix chained receiver temps, C container move-assign mono lookup, aarch64 anchor-walk array cleanup

## 0.6.8
<sub>2026-10-01</sub>

-  *(patch)*
  Array<T> params accept varying-length literals (stamp dropped on conflict instead of erroring); raw T[] params keep the conflict check
-  *(patch)*
  C branch builders copy heap_string_fields per branch (in-place record adds leaked into siblings, freeing zero-init field defaults)
-  *(patch)* - Fix: value-struct elements in aarch64 Array<T> literals
-  *(patch)*
  nomen test accepts --release: optimized test/bench builds (optimize passes + clang -O2), so t.bench numbers are meaningful
-  *(patch)* - nomen test links the build result's companion C file (spawn/UI test files no longer fail to link)
-  *(patch)* - #embed_file + test binary CWD contract
-  *(patch)* - conditional ref-param string field transfer
-  *(patch)* - Buffer field deep-copy in container elements

## 0.6.7
<sub>2026-09-30</sub>

-  *(patch)* - Fix: owning container fields transfer/deep-copy in containers
-  *(patch)* - Fix: normalize plain = assignment operator
-  *(patch)* - Fix: nullable scalars everywhere: simple enums/bitsets get the _has flag, file-scope globals apply initializers, flagged-nullable container/array elements and data enums are rejected

## 0.6.6
<sub>2026-09-30</sub>

-  *(patch)* - Fix: null-safe string dup on struct return
-  *(patch)* - Fix: string[] parameter length on C
-  *(patch)* - Fix: switch case condition temp placement
-  *(patch)* - Fix: exclusive-branch string field records
-  *(patch)* - Fix: loop promotion shared carried registers
-  *(patch)* - Fix: aarch64 value-struct branch field stores
-  *(patch)* - Fix: nullable ?? string result ownership
-  *(patch)* - Fix: conflicting array param lengths rejected
-  *(patch)* - Fix: nullable string local assignment aliasing the source (aarch64 dup gate)
-  *(patch)* - Fix: override-constructor returns normalized (dangling heap-local fields)
-  *(patch)* - Fix: last-use scan misses checker-hoisted interpolation reads
-  *(patch)* - Fix: override ctor displaced-copy reclamation + hoisted arg emission
-  *(patch)* - Fix: aarch64 never evaluated non-literal field defaults
-  *(patch)* - Fix: #init computed-seed ownership: record/reclaim on both backends
-  *(patch)* - Fix: ref-param field stores transfer records to caller
-  *(patch)* - Fix: warn on redundant move on value-struct fields

## 0.6.5
<sub>2026-09-29</sub>

-  *(patch)* - Fix: reject moved value-struct local at trait boundary
-  *(patch)* - Fix: nullable scalar values track null via a companion flag
-  *(patch)* - Fix: initialize and free trait-declared fields
-  *(patch)* - Fix: nullable struct member ownership
-  *(patch)* - Fix: normalize struct constructor returns
-  *(patch)* - Fix: pair-load string array elements
-  *(patch)* - Fix: treat field-read string locals as borrows
-  *(patch)* - Fix: allow raw as an identifier

## 0.6.4
<sub>2026-09-28</sub>

-  *(patch)* - aarch64 nullable struct local frees guarded on _has flag
-  *(patch)* - nullable struct reassignment reclaims old value
-  *(patch)* - global const array literal initializers
-  *(patch)* - move destructuring for tuples and structs
-  *(patch)* - last-use move inference for tuple literals
-  *(patch)* - tuple return string transfer, no dangle
-  *(patch)* - for-of over field access chains
-  *(patch)* - aarch64 call-chained field receiver address
-  *(patch)* - tuple return string normalization
-  *(patch)* - drop dead C epilogue auto-free
-  *(patch)* - fix aarch64 func-value string return leak
-  *(patch)* - fix aarch64 func-value arg overflow and ordering
-  *(patch)* - reject lambda arity mismatch against zero-param func type

## 0.6.3
<sub>2026-09-27</sub>

-  *(patch)* - nested field write through a class-typed field
-  *(patch)* - nomen test: audit leaks count as failures
-  *(patch)* - honor --in over package entry
-  *(patch)* - Regex: lookbehind, counted repetition, non-capturing groups
-  *(patch)* - nullable func types (func? / Func<...>?)
-  *(patch)* - lambda assignment to func variables/fields
-  *(patch)* - returned value structs no longer leak string fields
-  *(patch)* - owning struct args: reject aliased params the callee writes
-  *(patch)* - owning-struct arg gate applies to library too
-  *(patch)* - pass-by-value for owning value-struct args
-  *(patch)* - move-declared params of owning value structs transfer ownership (no boundary copy, source invalidated)
-  *(patch)* - copy() synthesized for monomorphized structs and required-param inits
-  *(patch)*
  CLI: dev-tree asset resolution prefers the repo's live core/ over a stale cli/core bundle copy left by an old build (published installs unchanged)

## 0.6.2
<sub>2026-09-24</sub>

-  *(patch)* - Fix: Regex engine escapes (\r, \n, \t) and pattern-escape lint
-  *(patch)* - aarch64: spill call args across sibling arg evaluation
-  *(patch)* - fold composed const strings into single literals
-  *(patch)* - regex: continuation-aware alternation backtracking
-  *(patch)* - add List.set_or_panic (runtime-checked write)
-  *(patch)* - hoist composed module consts like functions
-  *(patch)* - StringBuilder: explicit member visibility
-  *(patch)* - nomen test: name the failing stage in reports
-  *(patch)* - fold module-level primitive const initializers

## 0.6.1
<sub>2026-09-24</sub>

-  *(patch)* - Fix: System::Text import dragging Controls into builds; test TUs as .m on macos
-  *(patch)* - Fix: Regex prefilter dropped nullable first atoms
-  *(patch)* - Fix: void lambda lowered as value return
-  *(patch)* - Fix: variable_types leaked across function builds
-  *(patch)* - Fix: audit-only free wrapper emitted in non-audit asm
-  *(patch)* - Feat: StringBuilder read-back/trim API

## 0.6.0
<sub>2026-09-23</sub>

-  *(minor)* - Thread.start/detach and Fiber.start become real library methods with lexical nursery capture (ASYNC_PLAN phase 1)
-  *(minor)* - Spawnable<T> trait; Thread/Fiber conform; mono clones carry substituted trait args (ASYNC_PLAN phase 2)
-  *(minor)* - #spawn construction marker; special form keyed on the member, not the name (ASYNC_PLAN phase 3)
-  *(minor)* - Drop generalized Awaitable construction sugar; #spawn is the only construction hook (ASYNC_PLAN phase 4)
-  *(minor)* - Shrink Sendable to shared class/trait refs; exempt moved and copied values; retire nursery borrows (ASYNC_PLAN phase 5)
-  *(minor)* - Runtime dependency keyed on library body content; declared Task deps replace token scan (ASYNC_PLAN phase 6)
-  *(minor)* - Add Random (splitmix64) to the System library
-  *(minor)* - Add Task.is_done; fix aarch64 Channel.send_string fiber wake
-  *(patch)* - Fix aarch64 large immediate expansion
-  *(patch)* - Fix aarch64 class ctor stack imbalance
-  *(patch)* - Fix aarch64 trait dispatch receiver marshalling
-  *(patch)* - Fix aarch64 class field ctor default
-  *(patch)* - Fix aarch64 value-struct ctor dest in return buffer
-  *(patch)* - Fix aarch64 class-field chain receiver
-  *(patch)* - Fix aarch64 moved-param destroy base
-  *(patch)* - Fix aarch64 adr and literal-pool range
-  *(patch)* - Fix aarch64 null string return strdup
-  *(patch)* - Fix aarch64 if/else branch scope frames
-  *(patch)* - Fix aarch64 to_string force-heap init
-  *(patch)* - Fix aarch64 fold of reassigned string vars
-  *(patch)* - Fix: no space before paren in `panic(`, `move(`, etc
-  *(patch)*
  Strip redundant generic constructor annotations (`var keys = Buffer<TK>()`); infer the type instead. Colour generic `<...>` brackets and type parameters in the extension.
-  *(patch)* - Add demos/async GUI demo app; record async-loop FOLLOWUP notes
-  *(patch)* - Fix owned-return receiver leak (chained Task handles)
-  *(patch)* - Fix aarch64 fn-value spawn rodata result crash
-  *(patch)* - Fix aarch64 zero-arg spawn ctor signature
-  *(patch)* - Return inside async block joins the nursery
-  *(patch)* - Fix aarch64 string accumulation in a loop inside async
-  *(patch)* - Fix aarch64 spawn ctor arg types conflicting across sites
-  *(patch)* - Free unconsumed string task results at future release

## 0.5.0
<sub>2026-09-21</sub>

-  *(minor)*
  Replace the spawn keyword with the Thread class: spawn fn(args) becomes Thread(fn(args)).start(), and the nursery escape hatch name.spawn(fn(args)) becomes name.start(Thread(fn(args))); spawn leaves the reserved-words list (Phase 0 of ASYNC_PLAN.md)
-  *(minor)*
  Add Fiber: stackful coroutine tasks over the worker pool. Fiber(fn(args)).start() yields a Task<T> like Thread, but a waiting fiber parks (freeing its worker) instead of blocking; Fiber.yield/is_fiber, Fiber.start_on(buffer) on a caller-provided stack (C backend), and Fiber.set_cooperative for no-thread single-threaded runs
-  *(minor)*
  Park-aware Channel: an empty receive from a fiber parks on the channel wait list instead of blocking its worker, send wakes parked receivers, and a cancelled waiter returns instead of waiting forever; cancellation now reaches parked fibers (Task.cancel/nursery timeout schedule the owning fiber and restore its task-local cancel flag on resume); fix __nomen_future_timedwait to use a real absolute deadline
-  *(minor)*
  Add the async I/O netpoller (kqueue/epoll) with __nomen_io_wait parking fibers on socket readiness, and a non-blocking Tcp stdlib (listen/accept/connect/send/recv/recv_all/close); concurrent-connection scale validation and the Http port are still pending
-  *(minor)* - Closure descriptor ABI: func values carry { code, env, owned } (Phase 1 of docs/CLOSURE_PLAN.md)
-  *(minor)* - Closure captures phase 2a: lambdas capture outer scalars by copy (heap env + owned descriptor, freed at scope exit)
-  *(minor)* - Closure captures phase 2b: lambdas capture outer strings (deep-copied into the env with a per-lambda destructor)
-  *(minor)* - Closure captures phase 2c: lambdas capture non-owning value structs by copy
-  *(minor)*
  Closure captures phase 2c part 2: lambdas move-capture owning value structs, class instances, and nested capturing closures (donor-local invalidation, env destruction)
-  *(minor)*
  Closure captures follow-ups: move-captured move parameters, class-backed trait references, and move-only capturing values (func-field ownership, value-struct field rejection)
-  *(minor)*
  Make Thread(fn(args)) / Fiber(fn(args)) real storable library classes: eager argument binding, start-later, and must-start enforced by #destroy (destroying an unstarted value aborts with an explanation)
-  *(minor)*
  Accept zero-argument function values in the spawn construction — Thread(() => work(base)) with the lambda's captures as the eager arguments — including through the nursery escape hatch
-  *(minor)*
  Own the spawn env's packed arguments (deep-copied strings, copied-and-destroyed owning structs) so tasks cannot dangle their donors' buffers; allow non-Sendable class arguments inside nurseries as join-bounded borrows (detach still requires owned args); add the Awaitable trait (Task<T> conforms); and make cancellation observable to channel-waiting thread tasks with the nursery join waiting for done after cancel
-  *(minor)*
  The Awaitable construction sugar generalizes beyond Thread/Fiber: any user class conforming to Awaitable with the spawn-field contract (uint64 task/result_slot/cancel_flag/future, optional started) takes the same eagerly-packed construction, launches through the new Task.pool_submit / Task.future_* library seam, dispatches through the Awaitable vtable, and monomorphizes as C<T>; a contract-missing class gets a dedicated compile error
-  *(minor)*
  Anonymous functions gain the keyword form inline (func (out int) { ... }, func (x) => x * 2) and the block-without-arrow form parses inline too; passing a func-typed binding as a call argument no longer false-mismatches ('int (expected func)') or resolves to the static descriptor over the local's heap closure
-  *(minor)* - Add #init field-completeness checker diagnostic
-  *(minor)* - Remove block-body lambda forms: '=>' now takes a single expression only; block bodies require the func keyword
-  *(minor)* - Missing return now fires for signature-merged lambdas (declaration annotation, func-typed arg, func-typed field)
-  *(minor)* - Add nested func types and closure factories
-  *(minor)* - Add Func<> function types
-  *(patch)*
  Fix the nursery futures list overflowing at 64 concurrent spawns (fixed stack array -> heap list on the C backend, pointer slot on aarch64); un-skips and passes the concurrent Tcp echo test at 256 connections on both backends
-  *(patch)* - Fix: Channel #destroy frees only owned-string payloads
-  *(patch)* - Fix: aarch64 frame offsets past the imm12 limit
-  *(patch)* - Fix: Mutex.lock parks in the threaded model
-  *(patch)* - Fix: one shared concurrency runtime per process in C system_lib builds
-  *(patch)* - Fix: aarch64 system companion carries library aarch64_use_c bodies
-  *(patch)* - Fix: finish async Phase 3 — Http over Tcp, growable nursery lists, module-level statements
-  *(patch)* - Fix: scope aarch64 status.moved per struct method body
-  *(patch)* - Runtime deadlock detector: abort with a wait-graph dump instead of hanging silently
-  *(patch)* - Thread(fn(args)).detach(): daemon tasks on a dedicated detached pthread that never block nursery join or process exit
-  *(patch)* - Fix aarch64 closure captures read through address-taking paths (method receivers)
-  *(patch)*
  Lower the spawn runtime onto the closure descriptor ABI (the pool, fiber scheduler, and daemon launcher take a single task closure) and fix the daemon form's double-free of its args struct
-  *(patch)*
  C backend: string methods on view string receivers alias the view into the callee's pair (test/view_string_methods.test.ts)
-  *(patch)*
  C backend: switch case-condition statement hoister no longer shreds statement expressions (splits at top-level semicolons only)
-  *(patch)* - Custom #init first field write no longer destroys uninitialized garbage (C + aarch64)
-  *(patch)* - Re-assigning a borrowed class alias from another borrow keeps it non-owning (C backend)
-  *(patch)*
  While-loop condition temporaries re-evaluate every iteration (C + aarch64); hoisted call args no longer freeze the condition
-  *(patch)* - field = move local into a value-struct field transfers ownership (splices the source) instead of dangling it
-  *(patch)* - C trait dispatch: ref args rooted at class locals now pass &slot (address-of was dropped)
-  *(patch)* - nomen format: hyphenated import names survive formatting (intra-name hyphens bind tight)
-  *(patch)*
  nomen test: *.test.nm entries no longer inline their folder's sibling test files (quadratic build weight OOMed the suite)
-  *(patch)*
  fix quadratic string volume in the C emitter (scratch-buffer speculative emission + node-driven statement tails); 4MB-code builds no longer OOM
-  *(patch)*
  aarch64 emitter: chunked code buffer + per-function bodies kill the quadratic string-volume cost (endsWith peeks, whole-file peephole scans, peephole spread overflow)
-  *(patch)* - Fix: aarch64 trait dispatch ref class-local arg marshal
-  *(patch)* - Fix: dispose inline capturing lambda descriptors at direct call sites
-  *(patch)* - Fix: dispose inline capturing lambda descriptors at method and trait-dispatch call sites
-  *(patch)* - Fix: aarch64 closure direct-call inlining
-  *(patch)* - Fix: check func value signatures at use sites
-  *(patch)* - Fix: nested function absorbs enclosing hoisted temporaries

## 0.4.0
<sub>2026-09-17</sub>

-  *(minor)*
  Constructor overloading: multiple #init functions with differing parameter types; constructor calls resolve the overload by argument count and types on both backends
-  *(minor)* - replace BigInt.new with an int #init overload
-  *(minor)*
  Buffer/ClassBuffer modify_T: sound in-place slot mutation (the load-modify-store dance) on both backends; generic func (T, out T) params monomorphize correctly; C func-pointer signatures use tag forms; aarch64 func-param calls pass fat-string pairs
-  *(patch)*
  move-param leak fix: a method call on a moved class param no longer disables the callee's epilogue reclaim unless the method can retain its receiver
-  *(patch)*
  fix monomorphization of generic-enum returns from generic-struct methods (signature, locals, deferred case constructions)
-  *(patch)*
  base-seeded literals: scalar override values are evaluated into temporaries before the base copy/init, so an override reading the destination sees the pre-assignment value
-  *(patch)* - fix aarch64 variadic-pairs Map constructor (value-struct TV tuple packing passed the first word instead of the address)
-  *(patch)*
  fix generic enums with class/trait payloads: mono case payload rides as a struct Tag pointer on C, payload ownership enforced at check time, payload destroy+free at scope exit on both backends
-  *(patch)* - Fix: residual string hazards
-  *(patch)* - Fix: bitset immediates, self rewrite, array scoping
-  *(patch)* - Fix: modify_T-corpus aarch64 ownership bugs (store_T move, mono string fields, ctor clobber)
-  *(patch)* - Fix: match-expression result lowering (aarch64 fat-pair join, C reassign switch)
-  *(patch)* - Fix: field-override destination reads, move-reassign ownership
-  *(patch)*
  Fix enum-with-string-payload ownership in value structs (field stores, destroy walk, sret field-read returns) on both backends
-  *(patch)* - Fix aarch64 inline splices: isolate body locals so nested generic splices (List.at, JsonTree) compile correctly
-  *(patch)* - Scope-label same-named nested types so the build's flat type table can't be poisoned (struct/class/enum/bitset)
-  *(patch)* - Enums with string payloads as container elements: owning Buffer/List deep-copy on both backends
-  *(patch)* - Add internal visibility modifier; make Buffer internal to the System library
-  *(patch)* - Add readonly fields (read anywhere, assignable only inside the declaring type)
-  *(patch)* - Re-export Buffer with a sound public API; drop the _T suffix from the size-aware primitives
-  *(patch)* - Enforce internal type-name visibility; fix generic struct-field swap codegen
-  *(patch)* - Remove dead Buffer address pipeline (ASM_PLAN_3 tranche K) and its BuildStatus fields
-  *(patch)*
  Fix folded store addressing on aarch64: the region-bracket base-fold's bare-induction register was dropped when the tranche-K hoist block was removed, so store_int through a folded base indexed with a stale staging register (edigits segfault, pidigits wrong digits)

## 0.3.0
<sub>2026-09-14</sub>

-  *(minor)* - string replace_first/replace_all with view needle/replacement
-  *(minor)* - System::string query methods: index_of, contains, prefix/suffix, char_code_at, substring, trim, case mapping
-  *(minor)* - StringBuilder.append_string_view and seed: memcpy views without to_string copies
-  *(minor)* - char classification: is_digit, is_alpha, is_alphanumeric, is_ascii_space
-  *(minor)* - Regex.captures: capture group extraction into List<string>
-  *(minor)* - Regex.find + RegexMatch: mvzr-style match positions
-  *(minor)* - Regex lazy quantifiers: *? +? ??
-  *(minor)* - Regex case-insensitive matching: *_ci wrappers via pattern folding
-  *(minor)* - Regex backreferences: \1-\9 incl. quantified and lazy forms
-  *(minor)* - Regex \s \d \w shorthands with \S \D \W complements
-  *(minor)*
  Add `unsafe` (library-only): ptr T values, pointer indexing, pointer casts, and generic T_SIZE/T_NEEDS_STRDUP/T_FAT constants; rewrite core memory primitives (Buffer alloc/grow/zero/destroy, StringBuilder ensure/append/seed/destroy, Array at/first/at_end/set, String at/set) as unsafe Nomen with memory externs
-  *(minor)* - Base-seeded struct literals: [ .. base, field = value ] replaces the T() + [ ... ] override syntax
-  *(minor)* - string.char_code_at is bounds-constrained; add char_code_at_or / char_code_at_or_panic
-  *(minor)* - nomen check/build on a project file anchors to the package.jsonc entry
-  *(minor)* - Joiner walks the import graph cycle-safely; self-import and unresolvable-import diagnostics
-  *(minor)*
  Two-tier rule for value-struct trait conformers: cross-conformer reassignment, trait-array elements, and call-boundary passes of value-struct-backed trait locals are now check-time rejections; the inline local form is documented as tier 1 (docs/TRAITS.md)
-  *(minor)*
  Reject passing a view string where an owned string parameter is expected — call .to_string() to materialize (was: silent alias on aarch64, clang error on C)
-  *(minor)*
  Add System.Arena<T> + ArenaRef<T>: a generational arena (one owner, copyable generation-checked handles) for the single-ownership parent/child-reference pattern (allmark PORT)
-  *(minor)*
  Allow move on trait-typed parameters (checker + both backends reclaim via the trait <Trait>_destroy shim), unblocking add(move Renderer r) style APIs
-  *(minor)*
  Func-typed struct/class fields: declare, assign, and call s.f(args) via an indirect call (allmark BlockRule object shape)
-  *(patch)*
  Scope trait_class_locals per function body so a trait-typed local in one monomorphized body cannot poison later bodies' auto-free
-  *(patch)* - Verify Map rehash auto-free is fixed by trait_class_locals scoping; add regression test
-  *(patch)* - aarch64 custom init: spill fat string params as (ptr,len) register pairs so following scalars read the right registers
-  *(patch)* - C init: dup class string field literal defaults so reassignment/destroy never frees rodata
-  *(patch)*
  C return/cast: lower return 0 with a struct out type to a zero-initialized compound literal so Map<string, Struct> compiles
-  *(patch)* - Verify explicit List<Trait> annotations check clean (regression test)
-  *(patch)* - Reject func-typed struct/class fields with trait guidance; fix func-type field parse
-  *(patch)* - Allow methods to return class borrows rooted at self (accessor pattern); non-self borrows still rejected
-  *(patch)* - Constraint verifier: literal-length facts, same-base offset algebra, dotted-path offset args
-  *(patch)* - Tokenize escape pairs left-to-right; decode char-literal escapes in both backends
-  *(patch)* - Materialize rvalue trait receivers once; reclaim owned receivers on both backends
-  *(patch)* - aarch64 trait dispatch: free owned string results when all conformers return owned heap
-  *(patch)* - Checker: synthesize func-value calls for any signature (incl. out returns) and signature-check reassignment
-  *(patch)* - Map() + set() works for class/trait values; variadic pairs gate refined
-  *(patch)* - System.Text UTF-8 helpers (Utf8, Chars, CharIndex)
-  *(patch)* - Fix string-literal byte hazards (fold, lengths, NUL)
-  *(patch)* - Remove stale tuple bug report, already fixed
-  *(patch)* - aarch64: strdup a heap-local string stored into a ref-param struct field (store used to dangle)
-  *(patch)*
  aarch64 backend: constant rematerialization — float literal-pool loads become fmov immediates (hoisted out of hot loops), movz-range literal-pool loads become mov immediates
-  *(patch)*
  aarch64 backend: stack-staging elision — push/pop staging pairs around computed indexes become direct register reads (mov-form rename verdict-gated on exact liveness; bare pairs deleted as identities)
-  *(patch)*
  aarch64 backend: pointer-walk strength reduction — single-access loop addressing becomes post-index walked pointers (`ldr [w], #stride`), killing the index arithmetic from the memory op
-  *(patch)*
  aarch64 backend: auto method inline mechanism for small unmarked methods (ensure/clear-shaped) — lands kill-switch-only (default OFF) pending the JsonTree splice crash root-cause
-  *(patch)*
  aarch64 backend: ×2 unrolling of validated straight-line loop cycles (pre-guard hoist + body/guard duplication, exact for every trip count)
-  *(patch)*
  aarch64 backend: auto method inline unlocked (default ON) — small unmarked methods splice at call sites; bodies calling T-generic Buffer methods (load_T/store_T) take the real call (JsonTree crash class gated out)
-  *(patch)*
  aarch64 backend: naked inline expansion for allocation-free leaf bodies — BigInt limb accessors, ClassBuffer alloc/grow and JsonTree slab primitives converted from raw asm to plain Nomen (single-sourced across backends); List.at now takes a real call (generic-nested splice gate)
-  *(patch)* - Fix C-backend trait-typed local poisoning invalid C
-  *(patch)* - Scope aarch64 trait-class bindings per local
-  *(patch)* - Close C value-struct conformer dispatch gap
-  *(patch)* - Fix nullable string initialized to null emitting invalid C on the backend
-  *(patch)* - null into string? params and aarch64 defaulted nullable-string fields now lower to the zero pair
-  *(patch)*
  Trait-typed local copies of value-struct slots now build on C (concrete-struct declaration); class-backed trait-slot copies and value-struct stores into class-backed slots are check-time rejections; borrow-slot reassignment no longer destroys the shared instance on C
-  *(patch)*
  Reject storing a borrowed class value into an owning (move) class field — the borrowed shape double-freed on both backends; the move-param mutator idiom stays legal
-  *(patch)*
  Fix trait dispatch through container elements: C no longer takes the address of a class-typed receiver expression (container element), and aarch64 no longer frees a borrowed trait slot's container-owned element on reassignment
-  *(patch)*
  Plain func_call resolution must not resolve to a struct/trait method (a method named like a free function, e.g. Arena.free vs the extern free, stole the call)
-  *(patch)* - Fix lambda arguments and func-typed values on aarch64; reject func signature mismatches

## 0.2.3
<sub>2026-09-10</sub>

-  *(patch)* - Fix namespace imports resolving directories and spaced :: segments
-  *(patch)* - Desugar for x of List to element iteration

## 0.2.2
<sub>2026-09-10</sub>

-  *(patch)* - Fix: unify bound namespaces and chain inclusive bounds
-  *(patch)* - Fix: view to owned transfers materialize

## 0.2.1
<sub>2026-09-10</sub>

-  *(patch)* - Fix: honor --out as the linked binary path
-  *(patch)* - Fix: view receivers and view structs in Lists

## 0.2.0
<sub>2026-09-10</sub>

-  *(minor)*
  Rename keywords: `mov` → `move` (reads as English like the rest of the keyword set) and `strict` → `must_use` (names the actual rule — values may not be silently discarded — and avoids the one-letter `struct` collision)
-  *(patch)*
  Fix: C backend alias-own flags leak across functions (undeclared _alias_owns_X compile error when a later function reuses a variable name that a borrow was bound to in an earlier one)
-  *(patch)*
  Fix: C backend string-ownership sets (string_borrow_vars, moved_string_vars, heap_strings, owned_string_vars, moved) leak across functions like the alias maps did — a borrow-only local name in one function suppressed the scope-exit free of an unrelated owned same-named variable in a later one (leak visible under --audit)
-  *(patch)* - Add --audit/--audit-runtime support to the test command
-  *(patch)*
  Fix: element type of a cross-file generic return resolved order-independently — the mono instantiation is flowed at call time and materialized on demand at member access, so implicit-typed results (const diffs = combined(a, b)) no longer degrade to the bare type param in entry-first merge order
-  *(patch)*
  Fix: owned-string expression temps never freed on aarch64 — string comparisons (==/!=) now spill-and-free owned heap-temp operands (the result-type gate missed bool-yielding comparisons), grouped operands like ("a" + "b") + "c" classify as owned temps, nested-in-function callees resolve through their emission label, and the C backend's spill-and-free path no longer drops the != inversion
-  *(patch)* - Fix aarch64 ref-deref arg clobbering arg 0

## 0.1.0
<sub>2026-09-09</sub>

-  *(minor)* - Replace / namespace separator with :: and add qualified references (Namespace::Name) in code
-  *(minor)*
  Convert Http to the error-enum pattern: Http.get/post now return Result<string, HttpError> (new core/System/Stream/HttpError.nm) instead of a plain string with a 0 status sentinel
-  *(minor)*
  Add a `strict` enum modifier: values of a strict enum (core `Result`) can no longer be silently discarded in statement position — bind (`var _ = f.close()`) or match deliberately. Also fixes latent aarch64 pair-store range bugs the new discard locals exposed.
-  *(patch)*
  check/build: walk switch/match case subtrees in every generic AST scan via the shared child_nodes helper (warnings, ownership, last_use, string mutation scan, objc/NEON/inline/heap-return scans)
-  *(patch)* - Fix: keywords can't be used as variable, parameter, field, type, or case names
-  *(patch)* - Fix: validate imports
-  *(patch)*
  Fix: editor loads project-relative imports (subfolder modules) for hover/go-to-definition/diagnostics, refs work on generic type arguments, and import validation only applies to System-rooted paths
-  *(patch)* - aarch64: registerize loop inductions in region brackets
-  *(patch)* - Fix call-free scan missing struct operator calls
-  *(patch)* - Fix asm validator rejection of numeric local labels
-  *(patch)*
  Plain string assignment now restores value semantics (s = t strdups an owned copy) with move-on-last-use transfer for provably dead sources; fixes cross-scope dangle, return-escape, and ref-mutation aliasing UAFs on both backends
-  *(patch)* - aarch64: scratch-pool receiver hoists in region brackets
-  *(patch)*
  Close the plain string assignment residuals: borrow-initialized assignees now take an ownership restart (borrow receptions strdup'd on both backends, sound under untaken restart branches), explicit s = mov t actually transfers (was a C double free), and the C move gate accepts bare-variable-initializer sources
-  *(patch)*
  Convert core raw #arch blocks to plain Nomen (Math.power, primitive hashes, String.hash, Regex.find_next_byte); fix C-backend primitive-method self deref and add sxtb/sxth/sxtw to aarch64 asm validator
-  *(patch)* - Add extern func C-FFI declarations; convert atoi and strdup raw blocks to it
-  *(patch)* - Fix free library function resolution from parameterless main
-  *(patch)* - Fix checker name resolution shadowing core bodies
-  *(patch)* - aarch64: reload raw `#arch: aarch64` block params after control flow
-  *(patch)* - extern Math.log, method extern labels
-  *(patch)* - Fix: SLP pairs only form in call-free scopes (extern-sqrt nbody miscompile)
