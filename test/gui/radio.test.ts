import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #5 (GUI_PLAN): Radio — NSButton radio type (macOS). Group exclusivity
// is Nomen-level ("first selected wins" = uncheck the rest), so the runtime
// test drives exactly that pattern over two buttons.
describe("Radio control", () => {
	test(
		"Nomen-level group: selecting one unchecks the other",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Radio", 300, 200)
	var Radio left = Radio(win, "Left")
	var Radio right = Radio(win, "Right")
	left.set_checked(true)
	if left.is_checked() { Console.write("1") } else { Console.write("0") }
	if right.is_checked() { Console.write("1") } else { Console.write("0") }
	Console.write(" ")
	// First-selected-wins: the group check flips the new one on and the old
	// one off (the control has no native exclusivity).
	right.set_checked(true)
	left.set_checked(false)
	if left.is_checked() { Console.write("1") } else { Console.write("0") }
	if right.is_checked() { Console.write("1") } else { Console.write("0") }
	Console.write("\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "gui_radio", "10 01", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	test("Radio conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Radio trait", 300, 200)
	var Radio r = Radio(win, "One")
	Console.write(measured(r) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
