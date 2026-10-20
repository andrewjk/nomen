import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// Registered click handlers — the `.on_click` desugar (docs/HANDLERS.md,
// Stage 1): `self.btn.on_click(func () { ... })` is checker-interpreted —
// the closure body is hoisted into a hidden method on the app (`#on_click_1
// = (ref self, ref Window win)`), the registration site emits no code, and
// the app's synthesized `handle_clicks` drains the control's native click
// record each frame (before `frame`) by re-evaluating the remembered field
// path. The handler captures NOTHING: `self` inside the body is the hidden
// method's own receiver, borrowed by the run loop at dispatch — so a
// handler can read and mutate app state (`self.label`) with no twins and no
// capture-MOVES.
//
// The click is synthesized at the AppKit seam — performClick: fires the
// button's own target/action (armed at construction) exactly as a real
// click would; the next frame's handle_clicks drain consumes the record.
describe("control on_click handlers", () => {
	test(
		"registered handler dispatches with the app as receiver",
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

	// Wire the handler once the app is in final storage: the arm
	// re-evaluates self.btn's handle at dispatch, so registration needs no
	// captures and nothing can go stale.
	pub func start = (ref self, ref Window win) {
		self.btn.on_click(func () { self.label.set_text("clicked") })
	}

	// Synthesize the click at the AppKit seam: performClick: fires the
	// button's armed target/action (the ring recorder) synchronously — the
	// NEXT frame's handle_clicks drain runs the arm.
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
			// handle_clicks ran before this frame: the arm's hidden method set
			// the text through the ref-self receiver. Read it through the owner.
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
