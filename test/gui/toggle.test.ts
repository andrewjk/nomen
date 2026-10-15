import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #6 (GUI_PLAN): Toggle — NSButton push-on/push-off / UIButton
// selected. A Button variant that stays depressed until clicked again.
describe("Toggle control", () => {
	test(
		"set_checked / is_checked round trip",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Toggle", 300, 200)
	var Toggle t = Toggle(win, "Bold")
	if t.is_checked() { Console.write("on") } else { Console.write("off") }
	Console.write(" ")
	t.set_checked(true)
	if t.is_checked() { Console.write("on") } else { Console.write("off") }
	Console.write(" ")
	t.set_checked(false)
	if t.is_checked() { Console.write("on") } else { Console.write("off") }
	Console.write("\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "gui_toggle", "off on off", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	test("Toggle conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Toggle trait", 300, 200)
	var Toggle t = Toggle(win, "Italic")
	Console.write(measured(t) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
