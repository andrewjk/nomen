import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// Handler hosts beyond the root (docs/HANDLERS.md Stage 2): a USER-authored
// composite registers handlers on its own buttons and the app's dispatch
// forwards down the static field path — `self.pager.handle_clicks(ref win)`
// — direct calls, no trait objects. The composite's arms run with `ref self`
// = the composite, borrowed by the forwarding chain from the run root; the
// app never touches the pager's buttons — it mirrors the composite's state
// into its UI each frame (value polling, the doc's upward-notification
// tier 1).
//
// MyPager is the doc's motivating example: the natural code a user writes
// first, registering in #init while the buttons are being placed.
describe("composite handler hosts", () => {
	test(
		"the app forwards into a user composite and polls its state",
		{
			timeout: 300000,
		},
		async () => {
			const input = `
import System
import System::Controls

// A self-handling composite: #init registers one handler per button — the
// closures hoist to hidden methods on MyPager and the arms keep the page.
// No polls, no captures, no twins.
mv struct MyPager {
	var Button prev
	var Button next
	var int page = 0

	pub func #init = (self, Window window) {
		self.prev = Button(window, "<")
		self.next = Button(window, ">")
		self.prev.on_click(func () { self.page = self.page - 1 })
		self.next.on_click(func () { self.page = self.page + 1 })
	}

	// Wire the row into the caller's grid under \`parent\`.
	pub func add_to = (ref self, ref Container grid, int parent) {
		var int hs = grid.add_hstack(parent, 6, 1)
		grid.add_to_intrinsic(hs, self.prev.handle, 1)
		grid.add_to_intrinsic(hs, self.next.handle, 1)
	}
}

mv struct PagerApp : App {
	var MyPager pager
	var Text label
	var Container grid
	var int frames = 0

	pub func #init = (self, Window window) {
		self.label = Text(window)
		self.label.set_text("idle")
		var MyPager pager = MyPager(window)
		self.pager = pager
		var Container grid = VStack(8)
		grid.add(self.label.handle, 0, 24, 1)
		self.pager.add_to(ref grid, grid.root_index())
		self.grid = grid
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
	}

	// Synthesize a click at the AppKit seam: performClick: fires the next
	// button's armed target/action (the ring recorder) synchronously — the
	// NEXT frame's dispatch drains it through the forwarding chain and the
	// composite's own arm runs with the composite as receiver.
	pub func poke_next = (ref self) {
		\`\`\`
		#arch: c
		#platform: macos
		((void(*)(id, SEL, id))objc_msgSend)(
			(id)self->pager.next.handle, sel_registerName("performClick:"), (id)0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		((void(*)(id, SEL, id))objc_msgSend)(
			(id)self->pager.next.handle, sel_registerName("performClick:"), (id)0);
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

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			self.poke_next()
		}
		if self.frames == 3 {
			self.poke_next()
		}
		if self.frames == 4 {
			// handle_clicks drained before this frame: both clicks ran the
			// composite's arms. Mirror the state into the UI.
			self.label.set_text("page \\{self.pager.page}")
		}
		if self.frames == 5 {
			Console.write_line(self.label.get_text())
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("my_pager", 200, 160)
	var PagerApp app = PagerApp(win)
	win.run(mv app)
}
`;
			await build_and_check_output(input, "gui_composite_handlers", "page 2", true, {
				platform: "macos",
				audit: false,
			});
		},
	);
});
