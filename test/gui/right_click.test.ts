import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// The on_right_click handler — the window-level right-click event family
// (docs/HANDLERS.md). The drain is Container.take_right_click: it reads the
// pump's click-kind stamp (Window.nm's nomen_last_click_kind — the same
// record FrameEvents.click reports as 2), so the edge is visible exactly in
// the handle_events pass that follows the pump that saw the mouse-down. The
// record carries no hit: the HANDLER reads the click through the dispatch
// window (win.click_x()/click_y()) and hit-tests the container's children
// (contains) — the todo demo's right-click-delete shape.
//
// The right-click is synthesized at the AppKit seam — a synthetic
// NSEventTypeRightMouseDown posted into NSApp's queue at a row's coordinates;
// the next process_events pump stamps the kind, and that frame's drain runs
// the arm.
describe("control on_right_click handlers", () => {
	test(
		"registered right-click handler hit-tests and dispatches",
		{
			timeout: 300000,
		},
		async () => {
			const input = `
import System
import System::Controls

mv struct RightClickApp : App {
	var Container todos
	var List<CheckBox> owned
	var List<uint64> handles
	var int frames = 0

	pub func #init = (self, Window window) {
		// One row at the top of a plain VStack root (no scrollable, so
		// document space == window content space — the handler hit-tests
		// the window-space click directly).
		var Container todos = VStack(0)
		var List<CheckBox> owned = List<CheckBox>()
		var List<uint64> handles = List<uint64>()
		const cb = CheckBox(window)
		cb.set_title("item")
		todos.add(cb.handle, 0, 24, 1)
		handles.push(cb.handle)
		owned.push(mv cb)
		self.todos = todos
		self.owned = owned
		self.handles = handles
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.todos)
		self.todos.on_right_click(func () {
			var int found = -1
			var uint64 found_handle = 0
			var i = 0
			while i < self.handles.length; i += 1 {
				const uint64 h = self.handles.at(i)
				if self.todos.contains(h, win.click_x(), win.click_y()) {
					found = i
					found_handle = h
				}
			}
			if found != -1 {
				self.todos.remove_leaf(found_handle)
				{
					var CheckBox _dead = self.owned.remove_at_or_panic(found)
				}
				var uint64 _gone = self.handles.remove_at_or_panic(found)
			}
		})
	}

	// Synthesize the right-click at the AppKit seam: a right-mouse-down
	// event posted into the application queue at the row's center (the row
	// spans y 0..24 in top-left content coordinates; locationInWindow is
	// bottom-left origin, so flip y against the content height). The NEXT
	// frame's pump stamps the kind, and that frame's drain runs the arm.
	pub func poke = (ref self, ref Window win) {
		\`\`\`
		#arch: c
		#platform: macos
		id w = (id)win->handle;
		id cv = ((id(*)(id, SEL))objc_msgSend)(w, sel_registerName("contentView"));
		CGRect f = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
		NSInteger num = ((NSInteger(*)(id, SEL))objc_msgSend)(w, sel_registerName("windowNumber"));
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		id evt = ((id(*)(id, SEL, unsigned long long, NSPoint, unsigned long long, double, NSInteger, id, NSInteger, NSUInteger, float))objc_msgSend)(
			(id)objc_getClass("NSEvent"),
			sel_registerName("mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:"),
			3, // NSEventTypeRightMouseDown — the pump reports it as click kind 2
			((NSPoint){50.0, f.size.height - 12.0}),
			0, 0.0, num, (id)0, 0, 1, 0.0);
		((void(*)(id, SEL, id, BOOL))objc_msgSend)(nsapp, sel_registerName("postEvent:atStart:"), evt, 0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		id w = (id)win->handle;
		id cv = ((id(*)(id, SEL))objc_msgSend)(w, sel_registerName("contentView"));
		CGRect f = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
		NSInteger num = ((NSInteger(*)(id, SEL))objc_msgSend)(w, sel_registerName("windowNumber"));
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		id evt = ((id(*)(id, SEL, unsigned long long, NSPoint, unsigned long long, double, NSInteger, id, NSInteger, NSUInteger, float))objc_msgSend)(
			(id)objc_getClass("NSEvent"),
			sel_registerName("mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:"),
			3, // NSEventTypeRightMouseDown — the pump reports it as click kind 2
			((NSPoint){50.0, f.size.height - 12.0}),
			0, 0.0, num, (id)0, 0, 1, 0.0);
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
			self.poke(ref win)
		}
		if self.frames == 3 {
			// handle_events ran before this frame: the arm's hit-test found
			// the row and removed it through the ref-self receiver.
			Console.write_line("\\{self.owned.length}")
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("right_click", 200, 140)
	var RightClickApp app = RightClickApp(win)
	win.run(mv app)
}
`;
			await build_and_check_output(input, "gui_right_click", "0", true, {
				platform: "macos",
				audit: false,
			});
		},
	);
});
