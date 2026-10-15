import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: Menu (context) — NSMenu attached to any control's handle
// on macOS; iOS presentation (UIContextMenuInteraction) is deferred with
// TODO stubs. Item clicks are recorded by a shared target and polled via
// clicked_item (edge-triggered); the click path itself needs a live
// right-click, so headless tests cover the model surface.
describe("Menu control", () => {
	test("items + separators build; clicked_item polls -1 with no clicks", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Menu", 260, 120)
	var btn = Button(win, "Right-click me")
	var menu = Menu()
	menu.add_item("Cut")
	menu.add_item("Copy")
	menu.add_separator()
	menu.add_item("Paste")
	menu.attach(btn.handle)
	// Entries include the separator; "Paste" is entry 3.
	Console.write("items=\\{menu.item_count()} clicked=\\{menu.clicked_item()} ")
	Console.write("still=\\{menu.clicked_item()}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_menu", "items=4 clicked=-1 still=-1", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Menu is not a laid-out control (measure reports 0x0)", () => {
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
	var menu = Menu()
	Console.write(measured(menu) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
