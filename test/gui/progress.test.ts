import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #3 (GUI_PLAN): Progress — NSProgressIndicator (bar) / UIProgressView.
// Determinate value 0..1 plus the indeterminate flag, polled per frame.
describe("Progress control", () => {
	test("value round trip + indeterminate flag", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Progress", 300, 200)
	var Progress bar = Progress(win)
	Console.write("\\{bar.value()}")
	bar.set_value(0.25)
	Console.write(" \\{bar.value()}")
	if bar.is_indeterminate() { Console.write(" spin") } else { Console.write(" bar") }
	bar.set_indeterminate(true)
	if bar.is_indeterminate() { Console.write(" spin") } else { Console.write(" bar") }
	bar.set_indeterminate(false)
	bar.set_value(1.0)
	Console.write(" \\{bar.value()}")
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_progress",
			"0.000000 0.250000 bar spin 1.000000",
			true,
			{ platform: "macos", audit: false },
		);
	});

	test("Progress conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Progress trait", 300, 200)
	var Progress bar = Progress(win)
	Console.write(measured(bar) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
