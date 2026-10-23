import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// Registered pane roots (docs/HANDLERS.md "Beyond UIs", Container.set_pane):
// a pane grid registered with the run loop is re-laid by Window.relayout
// after every pass that could have re-framed its host view — the first
// post-show pass included. The app writes no layout code: start registers,
// the framework lays. The frame readback proves the populated registry
// actually walked (an unregistered grid's leaves stay at 0,0,0,0).
describe("registered pane roots", () => {
	test(
		"the run loop lays a registered pane after the first post-show pass",
		{ timeout: 300000 },
		async () => {
			const input = `
import System
import System::Controls

mv struct PaneApp : App {
	var SplitView split
	var Window pane_win
	var Container pane_grid
	var Text label
	var Container stack
	var int frames = 0

	pub func #init = (self, Window window) {
		var SplitView split = SplitView(window, 2, true)
		// The pane grid hosts a label on pane 0; registration is by scalar
		// handle (one borrow of self per call — the set_document trade).
		var Window left = split.content_window(0)
		var Container pane_grid = Grid(1, 0)
		var Text label = Text(left)
		label.set_text("pane")
		pane_grid.add(label.handle, 0, 24, 1)
		var Container stack = VStack(8)
		stack.add(split.handle, 0, 0, 1, 1)
		// Locals are used up before the moves into fields (mv — every use
		// after an assignment is an error), and the label moves too: its
		// scope-exit #destroy would release the live view otherwise.
		self.split = split
		self.pane_win = left
		self.pane_grid = pane_grid
		self.label = label
		self.stack = stack
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.stack)
		self.pane_grid.set_pane(self.pane_win.handle)
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			// The label (child 1) was framed by the framework's pane pass
			// during the first post-show relayout.
			var string f = self.pane_grid.fmt_frame(1)
			Console.write_line("laid=\\{f != "0,0,0,0"}")
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("pane_roots", 320, 200)
	var PaneApp app = PaneApp(win)
	win.run(mv app)
}
`;
			await build_and_check_output(input, "gui_pane_roots", "laid=true", true, {
				platform: "macos",
				audit: false,
			});
		},
	);
});
