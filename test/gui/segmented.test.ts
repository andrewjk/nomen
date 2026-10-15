import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #10 (GUI_PLAN): Segmented — NSSegmentedControl / UISegmentedControl.
// Fixed segment count at construction; labels + selection set/poll.
describe("Segmented control", () => {
	test(
		"labels, count, and selection round trip",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Segmented", 300, 200)
	var Segmented seg = Segmented(win, 3)
	seg.set_label(0, "Day")
	seg.set_label(1, "Week")
	seg.set_label(2, "Month")
	Console.write("\\{seg.count()} \\{seg.selected_index()}")
	seg.set_selected(2)
	Console.write(" \\{seg.selected_index()}")
	seg.set_selected(0)
	Console.write(" \\{seg.selected_index()}")
	Console.write("\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "gui_segmented", "3 0 2 0", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	test("Segmented conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Segmented trait", 300, 200)
	var Segmented seg = Segmented(win, 2)
	Console.write(measured(seg) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
