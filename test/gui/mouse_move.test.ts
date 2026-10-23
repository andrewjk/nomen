import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// on_mouse_move — the pointer-move record (docs/HANDLERS.md). The pump arms
// setAcceptsMouseMovedEvents on every pump (AppKit delivers no move events
// without it) and stamps the last seen position; the handler reads it
// through the dispatch window (`win.mouse_x()`/`mouse_y()`) and hit-tests
// for hover-style behavior.
//
// The move is synthesized with the classic NSEvent factory (type 5 — its
// location is window-local, unlike a CGEvent's global position) and posted
// into NSApp's queue: the NEXT frame's pump stamps the record and that
// frame's drain runs the arm.
describe("on_mouse_move handlers", () => {
	test(
		"move handler sees the pointer position",
		{
			timeout: 300000,
		},
		async () => {
			const input = `
import System
import System::Controls

mv struct MoveApp : App {
	var Text label
	var Container grid
	var int frames = 0

	pub func #init = (self, Window window) {
		var Text label = Text(window)
		label.set_text("idle")
		var Container grid = VStack(8)
		grid.add(label.handle, 0, 30, 1)
		self.label = label
		self.grid = grid
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
		self.grid.on_mouse_move(func () {
			if win.mouse_x() == 50 {
				if win.mouse_y() == 20 {
					self.label.set_text("moved")
				}
			}
		})
	}

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
			5, // NSMouseMoved
			((NSPoint){50.0, f.size.height - 20.0}),
			0, 0.0, num, (id)0, 0, 0, 0.0);
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
			5, // NSMouseMoved
			((NSPoint){50.0, f.size.height - 20.0}),
			0, 0.0, num, (id)0, 0, 0, 0.0);
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
			Console.write_line(self.label.get_text())
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("mouse_move", 200, 140)
	var MoveApp app = MoveApp(win)
	win.run(mv app)
}
`;
			await build_and_check_output(input, "gui_mouse_move", "moved", true, {
				platform: "macos",
				audit: false,
			});
		},
	);
});
