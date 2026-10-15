import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: SplitView — NSSplitView panes as layout roots on macOS;
// iOS (UISplitViewController is view-controller-level) is deferred with TODO
// stubs. Panes host controls via content_window(index) (the Scrollable
// `-contentView`-answers-self trick); divider positions are programmatic
// (set_position / position).
describe("SplitView control", () => {
	test("panes host layouts; divider position sets and reads back", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("SplitView", 320, 200)
	var SplitView split = SplitView(win, 2, true)
	const Window left = split.content_window(0)
	const Window right = split.content_window(1)
	var label_0 = Text(left)
	label_0.set_text("Left pane")
	var label_1 = Text(right)
	label_1.set_text("Right pane")
	var grid_0 = Grid(1, 0)
	grid_0.padding = 8
	grid_0.add(label_0.handle, 0, 24, 1)
	var grid_1 = Grid(1, 0)
	grid_1.padding = 8
	grid_1.add(label_1.handle, 0, 24, 1)
	grid_0.layout(left)
	grid_1.layout(right)
	split.set_position(100.0, 0)
	// "as int" converts inline (a stored-then-converted float hits an
	// aarch64 codegen bug — see FOLLOWUP.md, stale d0 on float reload).
	Console.write("count=\\{split.count()} pos=\\{split.position() as int}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_split_view", "count=2 pos=100", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("SplitView conforms to the Control trait (measure / intrinsic_size)", () => {
		const input = `
import System::Controls

func measured = (Control c, out string) {
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 800
	bc.max_height = 600
	var Size s = c.measure(bc)
	return "\\{s.width}x\\{s.height}"
}

pub func main = () {
	var Window win = Window("SplitView trait", 300, 200)
	var SplitView split = SplitView(win, 3, false)
	Console.write(measured(split) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
