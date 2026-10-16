import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 3 compositions — pure Nomen over existing controls (no new
// natives, no drawing), wired into the caller's grid as hstacks. NumberInput
// carries its value as INT HUNDREDTHS: a float param on a composite method
// hits the aarch64 method-splice staging bug (see FOLLOWUP.md), and
// hundredths map cleanly onto stepper increments.
describe("NumberInput composition", () => {
	test("set_value drives the stepper and mirrors the text as N.NN", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("NumberInput", 300, 120)
	var num = NumberInput(win)
	num.set_range(0, 1000, 100)
	num.set_value(300)
	var int v = num.value()
	Console.write("v=\\{v} text=\\{num.box.get_text()}")
	num.set_value(-250)
	Console.write(" neg=\\{num.box.get_text()}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_number_input", "v=300 text=3.0 neg=-2.5", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("add_to wires the pair into the caller's grid", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("NumberInput grid", 300, 120)
	var num = NumberInput(win)
	num.set_range(0, 1000, 100)
	num.set_value(400)
	var grid = Grid(1, 6)
	grid.padding = 8
	num.add_to(ref grid, grid.root_index(), 1)
	grid.layout(win)
	win.show()
	Console.write_line("laid out")
}
`;
		expect(parse(input, system).errors).toEqual([]);
		await build_and_check_output(input, "gui_number_input_grid", "laid out", true, {
			platform: "macos",
			audit: false,
		});
	});
});
