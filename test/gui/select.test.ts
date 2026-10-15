import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #9 (GUI_PLAN): Select — NSPopUpButton (macOS-first; iOS defers to a
// picker/action sheet). add/remove items, poll selected_index.
describe("Select control", () => {
	test("items, selection, and clear round trip", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Select", 300, 200)
	var Select pick = Select(win)
	pick.add_item("Red")
	pick.add_item("Green")
	pick.add_item("Blue")
	Console.write("\\{pick.count()} \\{pick.selected_index()}")
	pick.select_index(2)
	Console.write(" \\{pick.selected_index()}")
	pick.clear_items()
	Console.write(" \\{pick.count()} \\{pick.selected_index()}")
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_select", "3 0 2 0 -1", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Select conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Select trait", 300, 200)
	var Select pick = Select(win)
	Console.write(measured(pick) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
