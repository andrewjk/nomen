import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// The keyboard tier: `on_key_down` / `on_key_up` (Container.take_key_down /
// take_key_up) — window-level records drained through the take_<event>
// convention (docs/HANDLERS.md). The handler reads the record through the
// dispatch window: `win.key_code()` (hardware keycode — Space = 49),
// `win.key_modifiers()`, `win.key_repeat()` (auto-repeat filter),
// `win.key_up_code()`. FrameEvents carries the same record for `frame`
// (asserted here via ev.key_code). Text ENTRY is a different path (the
// field editor feeds TextBox.on_input) — these events are shortcuts and
// raw keys.
//
// Key events are synthesized at the AppKit seam:
// CGEventCreateKeyboardEvent wrapped via NSEvent.eventWithCGEvent and
// posted into NSApp's queue (postEvent:atStart:) — the NEXT frame's pump
// stamps the record and that frame's drains run, deterministic as in the
// mouse tests.
describe("keyboard handlers", () => {
	test(
		"on_key_down/on_key_up filter keycode; frame sees the record",
		{
			timeout: 300000,
		},
		async () => {
			const input = `
import System
import System::Controls

mv struct KeyboardApp : App {
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
		// Space (keycode 49), first press only — the auto-repeat filter.
		self.grid.on_key_down(func () {
			if win.key_code() == 49 {
				if win.key_repeat() == false {
					self.label.set_text("space")
				}
			}
		})
		self.grid.on_key_up(func () {
			if win.key_up_code() == 49 {
				self.label.set_text("released")
			}
		})
	}

	// A Space key-down (then key-up), synthesized through CGEvent and
	// posted into NSApp's queue: the NEXT frame's pump stamps the record,
	// and that frame's drains run the arms.
	pub func poke_key = (ref self, ref Window win, bool down) {
		\`\`\`
		#arch: c
		#platform: macos
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		CGEventRef cge = CGEventCreateKeyboardEvent(NULL, 49, down); // 49 = Space
		id evt = ((id(*)(id, SEL, void *))objc_msgSend)(
			(id)objc_getClass("NSEvent"), sel_registerName("eventWithCGEvent:"), (void *)cge);
		CFRelease(cge);
		((void(*)(id, SEL, id, BOOL))objc_msgSend)(nsapp, sel_registerName("postEvent:atStart:"), evt, 0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		CGEventRef cge = CGEventCreateKeyboardEvent(NULL, 49, down); // 49 = Space
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
			self.poke_key(ref win, true)
		}
		if self.frames == 3 {
			// The arm ran in handle_events before this frame; ev carries the
			// same record through the frame form.
			Console.write_line(self.label.get_text())
			Console.write_line("\\{ev.key_code}")
		}
		if self.frames == 4 {
			self.poke_key(ref win, false)
		}
		if self.frames == 5 {
			Console.write_line(self.label.get_text())
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("keyboard", 200, 140)
	var KeyboardApp app = KeyboardApp(win)
	win.run(mv app)
}
`;
			await build_and_check_output(input, "gui_keyboard", "space\n49\nreleased", true, {
				platform: "macos",
				audit: false,
			});
		},
	);
});
