import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: Tabs — NSTabView on macOS; iOS has no counterpart
// (UITabBarController is app-level chrome), so those blocks are deferred
// TODO stubs. Pages host controls via content_window(index), which hands
// back a Window-shaped value naming the page view (the Scrollable
// `-contentView`-answers-self trick).
describe("Tabs control", () => {
	test("labels + selection round-trip through the native item model", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Tabs", 300, 200)
	var Tabs tabs = Tabs(win, 2)
	tabs.set_label(0, "One")
	tabs.set_label(1, "Two")
	Console.write("count=\\{tabs.count()} sel=\\{tabs.selected_index()} ")
	tabs.set_selected(1)
	Console.write("now=\\{tabs.selected_index()}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_tabs", "count=2 sel=0 now=1", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("pages host controls; laid-out frames survive a page switch", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Tabs pages", 300, 220)
	var Tabs tabs = Tabs(win, 2)
	const Window page_0 = tabs.content_window(0)
	const Window page_1 = tabs.content_window(1)
	var label_0 = Text(page_0)
	label_0.set_text("First page")
	var label_1 = Text(page_1)
	label_1.set_text("Second page")
	var grid_0 = Grid(1, 0)
	grid_0.padding = 12
	grid_0.add(label_0.handle, 0, 24, 1)
	var grid_1 = Grid(1, 0)
	grid_1.padding = 12
	grid_1.add(label_1.handle, 0, 24, 1)
	grid_0.layout(page_0)
	grid_1.layout(page_1)
	tabs.set_selected(1)
	tabs.set_selected(0)
	Console.write("back on \\{tabs.selected_index()}\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
		await build_and_check_output(input, "gui_tabs_pages", "back on 0", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Tabs conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Tabs trait", 300, 200)
	var Tabs tabs = Tabs(win, 3)
	Console.write(measured(tabs) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
