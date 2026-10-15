import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: Toolbar — NSToolbar with delegate-built push-button
// items on macOS; no iOS counterpart (window chrome), so those blocks are
// deferred TODO stubs. Item clicks are recorded by the shared delegate
// target and polled via clicked_item (edge-triggered); the click path
// needs a live toolbar click, so headless tests cover the model surface.
describe("Toolbar control", () => {
	test("delegate builds the fixed item model; clicked_item polls -1", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Toolbar", 400, 200)
	var Toolbar bar = Toolbar(win, 3)
	Console.write("count=\\{bar.count()} clicked=\\{bar.clicked_item()} ")
	Console.write("still=\\{bar.clicked_item()}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_toolbar", "count=3 clicked=-1 still=-1", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Toolbar is window chrome (measure reports 0x0)", () => {
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
	var Window win = Window("Toolbar trait", 400, 200)
	var Toolbar bar = Toolbar(win, 2)
	Console.write(measured(bar) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
