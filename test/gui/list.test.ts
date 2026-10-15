import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: List / Table — single-column List (NSTableView,
// cell-based) on macOS; iOS (UITableView) deferred with TODO stubs. The
// data source bridge keeps rows in C globals read by the delegate IMPs —
// one List per process. A multi-column Table with view-based reusable
// cells is a later step.
describe("List control", () => {
	test("rows round-trip through the data source bridge", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("List", 260, 200)
	var List list = List(win)
	list.add_row("alpha")
	list.add_row("beta")
	list.add_row("gamma")
	Console.write("count=\\{list.row_count()} ")
	const string second = list.row(1)
	Console.write("r1=\\{second} ")
	list.set_row(1, "beta!")
	const string updated = list.row(1)
	Console.write("up=\\{updated} ")
	list.remove_row(0)
	Console.write("after=\\{list.row_count()}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_list",
			"count=3 r1=beta up=beta! after=2",
			true,
			{ platform: "macos", audit: false },
		);
	});

	test("selection polls and is programmatically settable", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("List selection", 260, 200)
	var List list = List(win)
	list.add_row("one")
	list.add_row("two")
	list.add_row("three")
	Console.write("sel=\\{list.selected_row()} ")
	list.select_row(1)
	Console.write("now=\\{list.selected_row()} ")
	list.clear()
	Console.write("empty=\\{list.row_count()} sel=\\{list.selected_row()}\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_list_selection",
			"sel=-1 now=1 empty=0 sel=-1",
			true,
			{ platform: "macos", audit: false },
		);
	});

	test("List conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("List trait", 300, 200)
	var List list = List(win)
	Console.write(measured(list) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
