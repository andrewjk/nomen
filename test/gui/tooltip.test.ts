import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #18 (GUI_PLAN): Tooltip — not a control; a pair of free helpers
// over `view.toolTip` keyed by any control's handle.
describe("Tooltip helpers", () => {
	test(
		"set_tooltip / get_tooltip round trip through a control handle",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Tooltip", 300, 200)
	var Button btn = Button(win, "Save")
	Console.write("'\\{get_tooltip(btn.handle)}'")
	set_tooltip(btn.handle, "Saves the document")
	Console.write(" '\\{get_tooltip(btn.handle)}'")
	set_tooltip(btn.handle, "")
	Console.write(" '\\{get_tooltip(btn.handle)}'")
	Console.write("\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "gui_tooltip", "'' 'Saves the document' ''", true, {
				platform: "macos",
				audit: false,
			});
		},
	);
});
