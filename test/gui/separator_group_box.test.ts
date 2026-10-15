import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #17 (GUI_PLAN): Separator + GroupBox — two trivial NSBox-backed
// files (separator style / primary style with a title), macOS-first.
describe("Separator + GroupBox controls", () => {
	test("Separator: box type is the native separator style", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Separator", 300, 200)
	var Separator line = Separator(win)
	Console.write("\\{line.box_type()}")
	line.set_frame(8, 8, 280, 4)
	Console.write(" ok\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_separator", "2 ok", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("GroupBox: title round trip + boxed style", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("GroupBox", 300, 200)
	var GroupBox box = GroupBox(win, "Account")
	Console.write("\\{box.box_type()} \\{box.get_title()}")
	box.set_title("Network")
	Console.write(" \\{box.get_title()}")
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_group_box", "0 Account Network", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Separator/GroupBox conform to the Control trait", () => {
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
	var Window win = Window("Box trait", 300, 200)
	var Separator line = Separator(win)
	var GroupBox box = GroupBox(win, "X")
	Console.write(measured(line) + " " + measured(box) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
