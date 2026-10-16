import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 3 compositions — pure Nomen over existing controls (no new
// natives, no drawing), wired into the caller's grid as hstacks. The
// composite `#init` assigns nested constructor calls straight into the
// fields, and the methods take float params — both shapes the aarch64
// backend stages correctly (see the composite_param_staging regression).
describe("NumberInput composition", () => {
	test("set_value drives the stepper and mirrors the text", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("NumberInput", 300, 120)
	var num = NumberInput(win)
	num.set_range(0.0, 10.0, 0.5)
	num.set_value(3.0)
	var float v = num.value()
	Console.write("v=\\{v} text=\\{num.box.get_text()} ")
	num.set_value(2.5)
	Console.write("half=\\{num.box.get_text()}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_number_input",
			"v=3.000000 text=3.000000 half=2.500000",
			true,
			{ platform: "macos", audit: false },
		);
	});

	test("add_to wires the pair into the caller's grid", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("NumberInput grid", 300, 120)
	var num = NumberInput(win)
	num.set_range(0.0, 10.0, 0.5)
	num.set_value(4.0)
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
