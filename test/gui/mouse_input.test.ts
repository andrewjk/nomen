import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// The exhaustive mouse surface: `on_mouse_down` (the raw tier — EVERY
// button, click count, modifiers) and `on_scroll` (continuous deltas), both
// window-level records drained through the take_<event> convention
// (docs/HANDLERS.md). The handler reads the record through the dispatch
// window: `win.mouse_button()` (1-based: 1 left, 2 right, 3 middle, 4+
// extras), `win.mouse_click_count()`, `win.mouse_modifiers()`,
// `win.scroll_dx()`/`scroll_dy()`. FrameEvents carries the same record for
// `frame` (asserted here via ev.mouse_button).
//
// Events are synthesized at the AppKit seam and posted into NSApp's queue
// (postEvent:atStart:), so the NEXT frame's pump stamps the record and that
// frame's drains run — deterministic, as in the right-click test. The
// middle-click is an NSOtherMouseDown (type 25) with Command modifiers and
// clickCount 2; the scroll is a CG scroll-wheel event wrapped via
// NSEvent.eventWithCGEvent (the factory that carries deltas).
describe("raw mouse + scroll handlers", () => {
	test(
		"on_mouse_down filters button/count/modifiers; on_scroll drains deltas",
		{
			timeout: 300000,
		},
		async () => {
			const input = `
import System
import System::Controls

mv struct MouseInputApp : App {
	var Text label
	var Scrollable scroll
	var Container grid
	var Container rows
	var List<CheckBox> owned
	var int frames = 0

	pub func #init = (self, Window window) {
		var Text label = Text(window)
		label.set_text("idle")
		var Scrollable scroll = Scrollable(window)
		var Window doc = scroll.content_window()
		var Container rows = VStack(0)
		var List<CheckBox> owned = List<CheckBox>()
		var CheckBox row = CheckBox(doc)
		row.set_title("row")
		rows.add(row.handle, 0, 24, 1)
		owned.push(mv row)
		var Container grid = VStack(8)
		grid.add(label.handle, 0, 30, 1)
		grid.add(scroll.handle, 0, 0, 1, 1)
		self.label = label
		self.scroll = scroll
		self.rows = rows
		self.owned = owned
		self.grid = grid
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
		self.rows.set_document(self.scroll.handle, self.scroll.doc_handle())
		// The raw tier: one registration covers every button, the click
		// count, and the modifiers — the arm filters on the record.
		self.rows.on_mouse_down(func () {
			if win.mouse_button() == 3 {
				if win.mouse_click_count() == 2 {
					// 0x100000 = NSModifierFlagCommand (the pump masks to
					// the device-independent bits)
					if win.mouse_modifiers() == 1048576 {
						self.label.set_text("cmd-middle")
					}
				}
			}
		})
		// Scroll: continuous input, its own family — the edge means "this
		// frame scrolled", the magnitudes are the payload.
		self.scroll.on_scroll(func () {
			if win.scroll_dy() > 0 {
				self.label.set_text("scrolled")
			}
		})
	}

	// A middle-click with Command held and clickCount 2, posted into
	// NSApp's queue. Synthesized through CGEventCreateMouseEvent — the
	// classic NSEvent factory has no buttonNumber parameter (it reads 0),
	// and the CGEvent carries the button field that NSEvent.buttonNumber
	// maps. The pump reports it through the raw button record (button 3),
	// NOT through FrameEvents.click (which stays 0/1/2).
	pub func poke_mouse = (ref self, ref Window win) {
		\`\`\`
		#arch: c
		#platform: macos
		id w = (id)win->handle;
		id cv = ((id(*)(id, SEL))objc_msgSend)(w, sel_registerName("contentView"));
		CGRect f = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		CGEventRef cge = CGEventCreateMouseEvent(NULL, kCGEventOtherMouseDown, ((NSPoint){50.0, f.size.height - 12.0}), kCGMouseButtonCenter);
		CGEventSetIntegerValueField(cge, kCGMouseEventClickState, 2); // double-click
		CGEventSetFlags(cge, kCGEventFlagMaskCommand);               // Command held
		id evt = ((id(*)(id, SEL, void *))objc_msgSend)(
			(id)objc_getClass("NSEvent"), sel_registerName("eventWithCGEvent:"), (void *)cge);
		CFRelease(cge);
		((void(*)(id, SEL, id, BOOL))objc_msgSend)(nsapp, sel_registerName("postEvent:atStart:"), evt, 0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		id w = (id)win->handle;
		id cv = ((id(*)(id, SEL))objc_msgSend)(w, sel_registerName("contentView"));
		CGRect f = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		CGEventRef cge = CGEventCreateMouseEvent(NULL, kCGEventOtherMouseDown, ((NSPoint){50.0, f.size.height - 12.0}), kCGMouseButtonCenter);
		CGEventSetIntegerValueField(cge, kCGMouseEventClickState, 2); // double-click
		CGEventSetFlags(cge, kCGEventFlagMaskCommand);               // Command held
		id evt = ((id(*)(id, SEL, void *))objc_msgSend)(
			(id)objc_getClass("NSEvent"), sel_registerName("eventWithCGEvent:"), (void *)cge);
		CFRelease(cge);
		((void(*)(id, SEL, id, BOOL))objc_msgSend)(nsapp, sel_registerName("postEvent:atStart:"), evt, 0);
		\`\`\`
		\`\`\`
		#arch: c
		#platform: ios
		/* TODO: iOS (see #init) */
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: ios
		/* TODO: iOS (see #init) */
		\`\`\`
	}

	// A 5-line scroll-wheel event, wrapped from a CGEvent so it rides
	// NSApp's queue like the mouse events (deterministic next-pump
	// delivery).
	pub func poke_scroll = (ref self, ref Window win) {
		\`\`\`
		#arch: c
		#platform: macos
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		CGEventRef cge = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, 5);
		id evt = ((id(*)(id, SEL, void *))objc_msgSend)(
			(id)objc_getClass("NSEvent"), sel_registerName("eventWithCGEvent:"), (void *)cge);
		CFRelease(cge);
		((void(*)(id, SEL, id, BOOL))objc_msgSend)(nsapp, sel_registerName("postEvent:atStart:"), evt, 0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		CGEventRef cge = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, 5);
		id evt = ((id(*)(id, SEL, void *))objc_msgSend)(
			(id)objc_getClass("NSEvent"), sel_registerName("eventWithCGEvent:"), (void *)cge);
		CFRelease(cge);
		((void(*)(id, SEL, id, BOOL))objc_msgSend)(nsapp, sel_registerName("postEvent:atStart:"), evt, 0);
		\`\`\`
		\`\`\`
		#arch: c
		#platform: ios
		/* TODO: iOS (see #init) */
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: ios
		/* TODO: iOS (see #init) */
		\`\`\`
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			self.poke_mouse(ref win)
		}
		if self.frames == 3 {
			// The arm ran in handle_events before this frame: the raw tier
			// delivered button 3 (middle), count 2, Command. ev.mouse_button
			// is the same record through the frame form.
			Console.write_line(self.label.get_text())
			Console.write_line("\\{ev.mouse_button}")
		}
		if self.frames == 4 {
			self.poke_scroll(ref win)
		}
		if self.frames == 5 {
			Console.write_line(self.label.get_text())
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("mouse_input", 200, 140)
	var MouseInputApp app = MouseInputApp(win)
	win.run(mv app)
}
`;
			await build_and_check_output(input, "gui_mouse_input", "cmd-middle\n3\nscrolled", true, {
				platform: "macos",
				audit: false,
			});
		},
	);
});
