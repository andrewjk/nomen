import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #20 (GUI_PLAN): Sheet — beginSheet:/UISheetPresentationController.
// The sheet's contentView is just another layout root: content_window()
// hands back a Window-shaped value that control constructors accept.
// present/dismiss exist but are not exercised (they animate against a
// real, visible host window).
describe("Sheet control", () => {
	test("title round trip, content window, presentation state", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Sheet host", 300, 300)
	var Sheet sheet = Sheet(win, 260, 140)
	sheet.set_title("Settings")
	Console.write("'\\{sheet.get_title()}' \\{sheet.is_presented()}")
	var Window content = sheet.content_window()
	var Button ok = Button(content, "OK")
	if ok.handle != 0 { Console.write(" hosted") } else { Console.write(" empty") }
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_sheet", "'Settings' false hosted", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Sheet conforms to the Control trait (through a Control receiver)", () => {
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
	var Window win = Window("Sheet trait", 300, 300)
	var Sheet sheet = Sheet(win, 260, 140)
	Console.write(framed(sheet) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
