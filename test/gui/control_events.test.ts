import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// Control-carried events beyond clicks (docs/HANDLERS.md, "Registered
// control events"): on_focus / on_blur are edges of the window's
// first-responder snapshot (polled once per frame by the synthesized
// handle_focus — a handoff fires the old control's blur and the new
// control's focus in the same frame), and on_input is a per-text-change
// edge (the field editor writes through to the control's value while
// typing).
//
// The test drives real focus changes with makeFirstResponder: and real text
// changes with set_text — the drains are passive polls over native state,
// so both are observed exactly as real user interaction would produce them.
describe("control events: focus / blur / input", () => {
	test("focus and blur edges track the first responder", { timeout: 300000 }, async () => {
		const input = `
import System
import System::Controls

mv struct FocusApp : App {
	var TextBox field_a
	var TextBox field_b
	var Container grid
	var int focus_a = 0
	var int blur_a = 0
	var int focus_b = 0
	var int blur_b = 0
	var int frames = 0

	pub func #init = (self, Window window) {
		self.field_a = TextBox(window)
		self.field_b = TextBox(window)
		var Container grid = VStack(8)
		grid.add(self.field_a.handle, 0, 24, 1)
		grid.add(self.field_b.handle, 0, 24, 1)
		self.grid = grid
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
		self.field_a.on_focus(func () { self.focus_a = self.focus_a + 1 })
		self.field_a.on_blur(func () { self.blur_a = self.blur_a + 1 })
		self.field_b.on_focus(func () { self.focus_b = self.focus_b + 1 })
		self.field_b.on_blur(func () { self.blur_b = self.blur_b + 1 })
	}

	// Drive real focus changes at the AppKit seam: makeFirstResponder:
	// begins editing the field (its field editor becomes first responder —
	// the focus snapshot maps the editor back to the control).
	pub func focus_a_now = (ref self, ref Window win) {
		\`\`\`
		#arch: c
		#platform: macos
		((id(*)(id, SEL, id))objc_msgSend)(
			(id)win->handle, sel_registerName("makeFirstResponder:"),
			(id)self->field_a.handle);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		((id(*)(id, SEL, id))objc_msgSend)(
			(id)win->handle, sel_registerName("makeFirstResponder:"),
			(id)self->field_a.handle);
		\`\`\`
	}

	pub func focus_b_now = (ref self, ref Window win) {
		\`\`\`
		#arch: c
		#platform: macos
		((id(*)(id, SEL, id))objc_msgSend)(
			(id)win->handle, sel_registerName("makeFirstResponder:"),
			(id)self->field_b.handle);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		((id(*)(id, SEL, id))objc_msgSend)(
			(id)win->handle, sel_registerName("makeFirstResponder:"),
			(id)self->field_b.handle);
		\`\`\`
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			self.focus_a_now(ref win)
		}
		if self.frames == 3 {
			// f3's handle_focus drained the gain; now hand off to b.
			self.focus_b_now(ref win)
		}
		if self.frames == 4 {
			// f4's handle_focus drained the handoff: b gained, a blurred.
			// b stays focused at close — its blur never fires.
			Console.write_line("\\{self.focus_a} \\{self.blur_a} \\{self.focus_b} \\{self.blur_b}")
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("focus_events", 260, 160)
	var FocusApp app = FocusApp(win)
	win.run(mv app)
}
`;
		await build_and_check_output(input, "gui_focus_events", "1 1 1 0", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("input edges fire per text change", { timeout: 300000 }, async () => {
		const input = `
import System
import System::Controls

mv struct InputApp : App {
	var TextBox field
	var Container grid
	var int changes = 0
	var int frames = 0

	pub func #init = (self, Window window) {
		self.field = TextBox(window)
		var Container grid = VStack(8)
		grid.add(self.field.handle, 0, 24, 1)
		self.grid = grid
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
		self.field.on_input(func () { self.changes = self.changes + 1 })
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			// One text change → one edge on the next drain.
			self.field.set_text("hello")
		}
		if self.frames == 3 {
			self.field.set_text("hello world")
		}
		if self.frames == 4 {
			Console.write_line("\\{self.changes}")
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("input_events", 240, 140)
	var InputApp app = InputApp(win)
	win.run(mv app)
}
`;
		await build_and_check_output(input, "gui_input_events", "2", true, {
			platform: "macos",
			audit: false,
		});
	});
});
