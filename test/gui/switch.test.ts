import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #1 (GUI_PLAN): Switch — NSSwitch / UISwitch, the settings-style
// toggle. The runtime test constructs one in a real window, drives the value
// API, and reads it back through the AppKit runtime (both backends build +
// run the same program).
describe("Switch control", () => {
	test("set_checked / is_checked round trip through NSSwitch", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Switch", 300, 200)
	var Switch sw = Switch(win)
	if sw.is_checked() { Console.write("on") } else { Console.write("off") }
	Console.write(" ")
	sw.set_checked(true)
	if sw.is_checked() { Console.write("on") } else { Console.write("off") }
	Console.write(" ")
	sw.set_checked(false)
	if sw.is_checked() { Console.write("on") } else { Console.write("off") }
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_switch", "off on off", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Switch conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Switch trait", 300, 200)
	var Switch sw = Switch(win)
	Console.write(measured(sw) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
