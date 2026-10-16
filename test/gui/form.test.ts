import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 3 compositions. Form pairs a GroupBox (drawn behind) with
// label+control rows composed on top through a ZStack of the caller's grid.
describe("Form composition", () => {
	test("rows pair labels with the caller's controls", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("Form", 340, 220)
	var form = Form(win, "Sign in")
	const name = TextBox(win)
	name.set_placeholder("user")
	const agree = CheckBox(win)
	agree.set_title("I agree")
	var grid = Grid(1, 6)
	grid.padding = 8
	form.add_to(ref grid, grid.root_index(), 1)
	form.add_row(ref grid, "Name", name.handle, 24)
	form.add_row(ref grid, "Terms", agree.handle, 24)
	grid.layout(win)
	win.show()
	Console.write("rows=\\{form.rows} title=\\{form.box.get_title()}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_form", "rows=2 title=Sign in", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("add_row past the four-label cap is a no-op", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("Form cap", 340, 260)
	var form = Form(win, "Cap")
	const boxes = CheckBox(win)
	var grid = Grid(1, 6)
	grid.padding = 8
	form.add_to(ref grid, grid.root_index(), 1)
	form.add_row(ref grid, "a", boxes.handle, 24)
	form.add_row(ref grid, "b", boxes.handle, 24)
	form.add_row(ref grid, "c", boxes.handle, 24)
	form.add_row(ref grid, "d", boxes.handle, 24)
	form.add_row(ref grid, "e", boxes.handle, 24)
	grid.layout(win)
	win.show()
	Console.write("rows=\\{form.rows}\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
		await build_and_check_output(input, "gui_form_cap", "rows=4", true, {
			platform: "macos",
			audit: false,
		});
	});
});
