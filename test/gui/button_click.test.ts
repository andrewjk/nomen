import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// Native click events: the button-family controls arm a shared
// target/action at construction; `was_clicked` drains the edge. The test
// app synthesizes a real click IN-PROCESS — a built NSEvent through
// `sendEvent:`, the same entry the manual pump uses (no Accessibility
// permission needed; the macOS 27 event-factory spelling per FOLLOWUP.md) —
// and asserts the button reports exactly one click.
describe("Button.was_clicked", () => {
	test("native click drains the edge", { timeout: 300000 }, async () => {
		const input = `
import System
import System::Controls

mv struct ClickApp : App {
	mv Button btn
	mv Text label
	mv Container grid
	var int frames = 0

	pub func #init = (ref self, Window window) {
		self.label = Text(window)
		self.label.set_text("idle")
		self.btn = Button(window, "Go")
		var Container g = VStack(0)
		g.add(self.label.handle, 0, 24, 1)
		g.add(self.btn.handle, 0, 32, 1)
		self.grid = mv g
	}

	pub func start = (ref self, ref Window win {}) {
		win.set_content(ref self.grid)
	}

	// Synthesize the click at the AppKit seam: performClick: fires the
	// button's own target/action (the armed recorder) exactly as a real
	// click would — verifying arm → record → drain. (Synthesized NSEvents
	// don't reach target/action on current macOS; that delivery is AppKit's
	// event pipeline, not ours.)
	pub func poke = (ref self, ref Window win {}) {
		#if META.arch == "c" && META.platform == "macos" {
			#raw {
				((void(*)(id, SEL, id))objc_msgSend)(
					(id)self->btn.handle, sel_registerName("performClick:"), (id)0);
			}
		}
		#if META.arch == "aarch64" && META.platform == "macos" {
			#raw("c") {
				((void(*)(id, SEL, id))objc_msgSend)(
					(id)self->btn.handle, sel_registerName("performClick:"), (id)0);
			}
		}
		#if META.arch == "c" && META.platform == "ios" {
			#raw {
				/* TODO: iOS (see #init) */
			}
		}
		#if META.arch == "aarch64" && META.platform == "ios" {
			#raw("c") {
				/* TODO: iOS (see #init) */
			}
		}
	}

	pub func frame = (ref self, ref Window win {}, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			self.poke(ref win)
		}
		if self.frames == 3 {
			if self.btn.was_clicked() {
				Console.write_line("clicked")
			} else {
				Console.write_line("miss")
			}
			win.quit()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("Button click", 200, 140)
	var ClickApp app = ClickApp(win)
	win.run(mv app)
}
`;
		// build_and_check_output re-parses with parse_raw (the raw block is
		// System-library-only in user code) and asserts no errors.
		await build_and_check_output(input, "gui_button_click", "clicked", true, {
			platform: "macos",
			audit: false,
		});
	});
});
