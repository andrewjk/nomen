import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #8 (GUI_PLAN): SearchField — NSSearchField / UISearchTextField.
// Cancel button + placeholder come free with the native class.
describe("SearchField control", () => {
	test(
		"set_text / get_text round trip",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("SearchField", 300, 200)
	var SearchField search = SearchField(win)
	Console.write("\\{search.get_text()}")
	search.set_text("nomen")
	Console.write(" \\{search.get_text()}")
	Console.write("\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "gui_search_field", " nomen", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	test("SearchField conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("SearchField trait", 300, 200)
	var SearchField search = SearchField(win)
	Console.write(measured(search) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
