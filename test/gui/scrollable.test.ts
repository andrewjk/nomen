import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: Scrollable — NSScrollView + a document view on macOS; iOS
// deferred (TODO stubs). The document view answers `-contentView` with itself
// so control constructors and Container.layout work unchanged, and the
// engine's y-flip runs against the document height (see the Scrollable
// design note in GUI.md).
describe("Scrollable control", () => {
	test(
		"content_window hosts controls; scroll_to_top zeroes the offset",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Scrollable", 300, 200)
	var Scrollable scroll = Scrollable(win)
	const Window content = scroll.content_window()
	var grid = Grid(1, 6)
	grid.padding = 8
	var row_a = Text(content)
	row_a.set_text("Row A")
	var row_b = Text(content)
	row_b.set_text("Row B")
	var row_c = Text(content)
	row_c.set_text("Row C")
	var row_d = Text(content)
	row_d.set_text("Row D")
	var row_e = Text(content)
	row_e.set_text("Row E")
	var row_f = Text(content)
	row_f.set_text("Row F")
	var row_g = Text(content)
	row_g.set_text("Row G")
	var row_h = Text(content)
	row_h.set_text("Row H")
	grid.add(row_a.handle, 0, 24, 1)
	grid.add(row_b.handle, 0, 24, 1)
	grid.add(row_c.handle, 0, 24, 1)
	grid.add(row_d.handle, 0, 24, 1)
	grid.add(row_e.handle, 0, 24, 1)
	grid.add(row_f.handle, 0, 24, 1)
	grid.add(row_g.handle, 0, 24, 1)
	grid.add(row_h.handle, 0, 24, 1)
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 240
	const Size cs = grid.measure(bc)
	scroll.set_content_size(cs.width, cs.height)
	grid.layout(content)
	scroll.scroll_to_top()
	Console.write("scroll y=\\{scroll.scroll_offset_y()}\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "gui_scrollable", "scroll y=0", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	test("Scrollable conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Scrollable trait", 300, 200)
	var Scrollable scroll = Scrollable(win)
	Console.write(measured(scroll) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});

	test("content_click translates window clicks into document coordinates", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("Scrollable clicks", 300, 200)
	var scroll = Scrollable(win)
	// 10 rows of 24 + 6px gaps (294 tall) in a 100-tall viewport, so the
	// document can scroll; the scroll view sits at the layout origin
	// (padding 0), so a click at (10, 20) is 20px below the visible top.
	var content = scroll.content_window()
	var grid = Grid(1, 6)
	var int made = 0
	while made < 10; made += 1 {
		var row = Text(content)
		row.set_text("Row")
		grid.add(row.handle, 0, 24, 1)
	}
	var root = Grid(1, 6)
	root.add(scroll.handle, 0, 100, 1)
	root.layout(win)
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 300
	const Size cs = grid.measure(bc)
	scroll.set_content_size(cs.width, cs.height)
	grid.layout(content)
	// Before scroll_to_top the document shows its bottom: the same window
	// click lands deeper into the content.
	var [bx, by] = content_click(scroll, 10, 20)
	const bool moved = by > 20
	Console.write("before_x=\\{bx} before_moved=\\{moved} ")
	scroll.scroll_to_top()
	var [ax, ay] = content_click(scroll, 10, 20)
	Console.write("after=\\{ax},\\{ay}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_scrollable_clicks",
			"before_x=10 before_moved=true after=10,20",
			true,
			{ platform: "macos", audit: false },
		);
	});
});
