import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: OutlineView — NSOutlineView (cell-based) on macOS; no iOS
// counterpart, so those blocks are deferred TODO stubs. The data-source
// bridge generalizes ListView's to a tree: nodes in a fixed-capacity
// C-global pool, items passed as opaque (id)(index + 1) pointers.
describe("OutlineView control", () => {
	test("tree builds top-down; expand + selection poll", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("OutlineView", 260, 220)
	var OutlineView outline = OutlineView(win)
	outline.add_item("Root A", -1)
	outline.add_item("Child 1", 0)
	outline.add_item("Child 2", 0)
	outline.add_item("Root B", -1)
	outline.set_expanded(0, true)
	Console.write("count=\\{outline.count()} sel=\\{outline.selected_row()}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_outline_view", "count=4 sel=-1", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("OutlineView conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("OutlineView trait", 300, 200)
	var OutlineView outline = OutlineView(win)
	Console.write(measured(outline) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
