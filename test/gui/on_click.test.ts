import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// Registered click handlers: `Window.on_click(handle, fn)` stores a
// { handle, closure } binding in a list on the window and each frame —
// before the app frame — `dispatch_clicks` drains the shared native click
// ring against the bindings. The handler closure captures the label's
// `#handle` VIEW twin (copyable, non-owning), so the capture does not move
// the control and the app keeps its own field; the mutation is visible
// through the OWNER (the twin's handle names the same native view).
//
// The click is synthesized at the AppKit seam — performClick: fires the
// button's own target/action (armed at construction) exactly as a real
// click would; the binding drain then consumes the ring record.
describe("Window.on_click", () => {
	test(
		"registered handler dispatches and mutates through the twin",
		{
			timeout: 300000,
		},
		async () => {
			const input = `
import System
import System::Controls

mv struct ClickApp : App {
	var Button btn
	var Text label
	var int frames = 0

	pub func #init = (self, Window window) {
		self.label = Text(window)
		self.label.set_text("idle")
		self.btn = Button(window, "Go")
	}

	// Wire the registered handler once the app is in final storage: the
	// handler closure captures a VIEW twin of the label (a copy — the
	// capture-MOVES rule never fires for a #handle twin), so the frame hook
	// keeps reading the owner field.
	pub func start = (ref self, ref Window win) {
		var TextHandle label_view = TextHandle(self.label)
		win.on_click(self.btn.handle, func () { label_view.set_text("clicked") })
	}

	// Synthesize the click at the AppKit seam: performClick: fires the
	// button's armed target/action (the ring recorder) synchronously — the
	// NEXT frame's dispatch_clicks drains the record against the binding.
	pub func poke = (ref self, ref Window win) {
		\`\`\`
		#arch: c
		#platform: macos
		((void(*)(id, SEL, id))objc_msgSend)(
			(id)self->btn.handle, sel_registerName("performClick:"), (id)0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		((void(*)(id, SEL, id))objc_msgSend)(
			(id)self->btn.handle, sel_registerName("performClick:"), (id)0);
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
			// dispatch_clicks ran before this frame: the binding's closure
			// set the text through the twin. Read it through the OWNER.
			Console.write_line(self.label.get_text())
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("on_click", 200, 140)
	var ClickApp app = ClickApp(win)
	win.run(mv app)
}
`;
			await build_and_check_output(input, "gui_on_click", "clicked", true, {
				platform: "macos",
				audit: false,
			});
		},
	);
});
