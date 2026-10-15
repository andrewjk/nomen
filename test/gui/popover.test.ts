import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #21 (GUI_PLAN): Popover — NSPopover, anchored to any control
// handle. show/dismiss are not exercised (they animate against a live
// anchor view); sizing and shown-state are.
describe("Popover control", () => {
	test(
		"content size round trip + shown state",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Popover", 300, 300)
	var Button anchor = Button(win, "Options")
	var Popover pop = Popover(win)
	var PopSize first = pop.content_size()
	Console.write("\\{first.width}x\\{first.height} \\{pop.is_shown()}")
	pop.set_content_size(240, 180)
	var PopSize now = pop.content_size()
	Console.write(" \\{now.width}x\\{now.height}")
	Console.write("\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "gui_popover", "200x120 false 240x180", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	test("Popover conforms to the Control trait (through a Control receiver)", () => {
		const input = `
import System::Controls

func framed = (Control c, out string) {
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 800
	bc.max_height = 600
	var Size s = c.measure(bc)
	return "\\{s.width}x\\{s.height}"
}

pub func main = () {
	var Window win = Window("Popover trait", 300, 300)
	var Popover pop = Popover(win)
	Console.write(framed(pop) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
