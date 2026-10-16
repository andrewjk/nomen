import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 3 compositions — pure Nomen over existing controls. OtpInput
// concatenates five SecureFields; Pagination tracks page state over a Button
// row; Form pairs GroupBox + label rows through a ZStack.
describe("OtpInput composition", () => {
	test("code concatenates the five fields; clear empties them", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("OtpInput", 300, 120)
	var otp = OtpInput(win)
	otp.f0.set_text("1")
	otp.f1.set_text("2")
	otp.f2.set_text("3")
	otp.f3.set_text("4")
	otp.f4.set_text("5")
	var string c = otp.code()
	Console.write("code=\\{c} ")
	otp.clear()
	var string empty = otp.code()
	Console.write("after=\\{empty}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_otp_input", "code=12345 after=", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("add_to wires the row into the caller's grid", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("OtpInput grid", 300, 120)
	var otp = OtpInput(win)
	var grid = Grid(1, 6)
	grid.padding = 8
	otp.add_to(ref grid, grid.root_index(), 1)
	grid.layout(win)
	win.show()
	Console.write_line("laid out")
}
`;
		expect(parse(input, system).errors).toEqual([]);
		await build_and_check_output(input, "gui_otp_input_grid", "laid out", true, {
			platform: "macos",
			audit: false,
		});
	});
});
