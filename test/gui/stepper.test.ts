import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #11 (GUI_PLAN): Stepper — NSStepper / UIStepper. min/max/increment
// + a polled value; pairs with a TextBox for "number input".
describe("Stepper control", () => {
	test("min/max/increment/value round trip", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Stepper", 300, 200)
	var Stepper step = Stepper(win)
	step.set_min(0.0)
	step.set_max(10.0)
	step.set_increment(2.0)
	step.set_value(4.0)
	Console.write("\\{step.value()}")
	step.set_value(10.0)
	Console.write(" \\{step.value()}")
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_stepper", "4.000000 10.000000", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Stepper conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Stepper trait", 300, 200)
	var Stepper step = Stepper(win)
	Console.write(measured(step) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
