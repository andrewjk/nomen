import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// Dynamic trees of self-handling rows (docs/HANDLERS.md Stage 4): a
// `List<MyRow>` field on the app is a DISPATCHABLE host collection — the
// synthesized `handle_clicks` gains a dispatch loop whose ELEMENT BORROW
// (`ref MyRow row = self.rows.at(i)`, lowered to the list's `slot_ptr`)
// binds the slot itself, so each row's own arms run IN PLACE and their
// state persists across frames. No per-row static field paths, no
// per-element vtables — a bounded loop and a pointer.
//
// The element borrow is also the user-facing form: `ref MyRow row =
// self.rows.at(i)` in app code borrows the slot for the statement's
// lifetime; any list mutation invalidates it through the ordinary rules.
describe("dynamic trees: List<MyRow> self-handling rows", () => {
	test(
		"the dispatch loop runs each row's arms in place",
		{
			timeout: 300000,
		},
		async () => {
			const input = `
import System
import System::Controls

// A self-handling row: its own button, its own handler, its own state.
mv struct MyRow {
	var Button btn
	var int count = 0

	pub func #init = (self, Window window) {
		self.btn = Button(window, "+1")
		self.btn.on_click(func () { self.count = self.count + 1 })
	}

	pub func add_to = (ref self, ref Container grid, int parent) {
		grid.add_to_intrinsic(parent, self.btn.handle, 1)
	}

	// Raw-only: the click synthesis must be the whole body (the aarch64
	// backend replaces it wholesale). Callers hand in the borrowed row.
	pub func poke = (ref self) {
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
		/* TODO: iOS */
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: ios
		/* TODO: iOS */
		\`\`\`
	}
}

mv struct RowsApp : App {
	var List<MyRow> rows = List<MyRow>()
	var Text label
	var Container grid
	var int frames = 0

	pub func #init = (self, Window window) {
		self.label = Text(window)
		self.label.set_text("idle")
		var Container grid = VStack(8)
		grid.add(self.label.handle, 0, 24, 1)
		// Rows are built as locals (composite wiring happens before the
		// move — GUI.md's aliasing rule) and pushed owned.
		var MyRow a = MyRow(window)
		a.add_to(ref grid, grid.root_index())
		self.rows.push(mv a)
		var MyRow b = MyRow(window)
		b.add_to(ref grid, grid.root_index())
		self.rows.push(mv b)
		self.grid = grid
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
	}

	// Synthesize a click on row \`index\`'s button at the AppKit seam. The
	// ELEMENT BORROW names the LIVE slot, so the raw handle read and the
	// row's own dispatch both target the stored row.
	pub func poke = (ref self, int index) {
		var i = 0
		while i < self.rows.length; i += 1 {
			if i == index {
				ref MyRow row = self.rows.at(i)
				row.poke()
			}
		}
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			self.poke(0)
		}
		if self.frames == 3 {
			self.poke(1)
		}
		if self.frames == 4 {
			// handle_clicks ran before this frame: the dispatch loop drained
			// each row's arms IN PLACE — both counters read back through the
			// list storage (the element borrow again for the reads).
			var string text = ""
			var i = 0
			while i < self.rows.length; i += 1 {
				ref MyRow row = self.rows.at(i)
				text = text + "\\{row.count} "
			}
			self.label.set_text(text)
		}
		if self.frames == 5 {
			Console.write_line(self.label.get_text())
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("dynamic_rows", 240, 180)
	var RowsApp app = RowsApp(win)
	win.run(mv app)
}
`;
			// The trailing space is the loop's separator.
			await build_and_check_output(input, "gui_dynamic_rows", "1 1 ", true, {
				platform: "macos",
				audit: false,
			});
		},
	);
});
