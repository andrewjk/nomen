import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #16 (GUI_PLAN): LevelIndicator — NSLevelIndicator (macOS-only).
// Star/capacity/rating display; style + value/max round trip.
describe("LevelIndicator control", () => {
	test("style / max / value round trip", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("LevelIndicator", 300, 200)
	var LevelIndicator stars = LevelIndicator(win)
	Console.write("\\{stars.value()}")
	stars.set_max(5.0)
	stars.set_value(3.0)
	Console.write(" \\{stars.value()}/\\{stars.max()}")
	stars.set_style(2)
	stars.set_value(7.5)
	Console.write(" \\{stars.value()}/\\{stars.max()}")
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_level_indicator",
			"0.000000 3.000000/5.000000 7.500000/5.000000",
			true,
			{ platform: "macos", audit: false },
		);
	});

	test("LevelIndicator conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("LevelIndicator trait", 300, 200)
	var LevelIndicator stars = LevelIndicator(win)
	Console.write(measured(stars) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
