import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #4 (GUI_PLAN): Spinner — NSProgressIndicator (spinning style) on
// macOS, UIActivityIndicatorView on iOS. start/stop with the state tracked
// at the Nomen level (no native isSpinning getter).
describe("Spinner control", () => {
	test("start / stop flips is_spinning", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Spinner", 300, 200)
	var Spinner spin = Spinner(win)
	if spin.is_spinning() { Console.write("spin") } else { Console.write("idle") }
	Console.write(" ")
	spin.start()
	if spin.is_spinning() { Console.write("spin") } else { Console.write("idle") }
	Console.write(" ")
	spin.stop()
	if spin.is_spinning() { Console.write("spin") } else { Console.write("idle") }
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_spinner", "idle spin idle", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Spinner conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Spinner trait", 300, 200)
	var Spinner spin = Spinner(win)
	Console.write(measured(spin) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
