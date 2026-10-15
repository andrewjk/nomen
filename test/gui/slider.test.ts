import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #2 (GUI_PLAN): Slider — NSSlider / UISlider. min/max/value, polled
// per frame by the manual event loop. The runtime test drives the value API
// through the AppKit runtime (both backends build + run the same program).
describe("Slider control", () => {
	test("min/max/value round trip (value clamps to the range)", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Slider", 300, 200)
	var Slider sl = Slider(win, 0.0, 100.0)
	Console.write("\\{sl.value()}")
	sl.set_value(50.0)
	Console.write(" \\{sl.value()}")
	sl.set_value(150.0)
	Console.write(" \\{sl.value()}")
	sl.set_min(10.0)
	sl.set_max(20.0)
	sl.set_value(0.0)
	Console.write(" \\{sl.value()}")
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_slider",
			"0.000000 50.000000 100.000000 10.000000",
			true,
			{ platform: "macos", audit: false },
		);
	});

	test("Slider conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Slider trait", 300, 200)
	var Slider sl = Slider(win, 0.0, 10.0)
	Console.write(measured(sl) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
