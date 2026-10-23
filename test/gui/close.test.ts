import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// on_resize + close_requested — the window lifecycle events
// (docs/HANDLERS.md). on_resize fires on the frame whose content rect
// changed (the framework has already re-laid-out the registered roots; the
// handler re-lays-out app-owned panes) and reads the new size through the
// dispatch window (win.resize_width()/resize_height()).
//
// close_requested is the unsaved-changes interception: the red button's
// native close is REFUSED by the delegate (pending flag set), and Window.run
// consults the app on the next frame — false declines (the window stays, a
// later request consults again), true force-closes. Programmatic
// win.close() bypasses the interception entirely, which is how the tests
// close windows.
//
// Synthesis: setFrame:display: on the window produces the resize;
// performClose: on the window is the red button (NOT win.close(), which is
// the forced programmatic form).
describe("window lifecycle events", () => {
	test(
		"on_resize fires; close_requested intercepts then allows",
		{
			timeout: 300000,
		},
		async () => {
			const input = `
import System
import System::Controls

mv struct LifecycleApp : App {
	var Text label
	var Container grid
	var bool allow_close = false
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
		self.grid.on_resize(func () {
			self.label.set_text("resized \\{win.resize_width()}x\\{win.resize_height()}")
		})
	}

	// The unsaved-changes pattern: decline the first request, allow the
	// rest. run consults this on the frame after the red button.
	func close_requested = (ref self, ref Window win, out bool) {
		if self.allow_close {
			return true
		}
		self.allow_close = true
		self.label.set_text("declined")
		return false
	}

	// Red-button simulation: performClose: WITHOUT the forced flag — the
	// delegate refuses it and sets the pending flag for run to consult.
	pub func poke_close = (ref self, ref Window win) {
		\`\`\`
		#arch: c
		#platform: macos
		((void(*)(id, SEL, id))objc_msgSend)((id)win->handle, sel_registerName("performClose:"), (id)0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		((void(*)(id, SEL, id))objc_msgSend)((id)win->handle, sel_registerName("performClose:"), (id)0);
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

	// A window resize: setFrame:display: changes the content rect — the
	// delegate relayouts the registered roots synchronously, and the next
	// frame's resize detection stamps the record for the drain.
	pub func poke_resize = (ref self, ref Window win) {
		\`\`\`
		#arch: c
		#platform: macos
		((void(*)(id, SEL, CGRect, BOOL))objc_msgSend)(
			(id)win->handle, sel_registerName("setFrame:display:"),
			((CGRect(*)(double, double, double, double))CGRectMake)(0.0, 0.0, 300.0, 200.0), 1);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		((void(*)(id, SEL, CGRect, BOOL))objc_msgSend)(
			(id)win->handle, sel_registerName("setFrame:display:"),
			((CGRect(*)(double, double, double, double))CGRectMake)(0.0, 0.0, 300.0, 200.0), 1);
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
			self.poke_resize(ref win)
		}
		if self.frames == 3 {
			// The resize was detected at this frame's top (before
			// handle_events ran the arm) — the label carries the new size,
			// and ev.width the same record through the frame form.
			Console.write_line(self.label.get_text())
			Console.write_line("frame \\{ev.width}")
		}
		if self.frames == 4 {
			self.poke_close(ref win)
		}
		if self.frames == 5 {
			// run consulted close_requested at this frame's top: declined,
			// window still open.
			Console.write_line(self.label.get_text())
		}
		if self.frames == 6 {
			self.poke_close(ref win)
		}
		// frame 7: run consults again — allowed → forced close → the loop
		// exits and main's line after run prints.
	}
}

pub func main = (Init init) {
	var Window win = Window("lifecycle", 200, 140)
	var LifecycleApp app = LifecycleApp(win)
	win.run(mv app)
	Console.write_line("closed")
}
`;
			await build_and_check_output(
				input,
				"gui_lifecycle",
				// 168 = the 200pt window frame minus the 32pt titlebar — the
				// record reports the CONTENT rect (same as FrameEvents).
				"resized 300x168\nframe 300\ndeclined\nclosed",
				true,
				{ platform: "macos", audit: false },
			);
		},
	);
});
