import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #12 (GUI_PLAN): TextView — NSTextView / UITextView. Multiline
// editing; sized explicitly by the container, value get/set round-trips
// through the native text storage.
describe("TextView control", () => {
	test("multiline set_text / get_text round trip", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("TextView", 300, 300)
	var TextView notes = TextView(win)
	Console.write("\\{notes.get_text()}")
	notes.set_text("line one\\nline two")
	Console.write("\\{notes.get_text()}")
	notes.set_text("reset")
	Console.write(" \\{notes.get_text()}")
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_text_view", "line one\nline two reset", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("TextView conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("TextView trait", 300, 300)
	var TextView notes = TextView(win)
	Console.write(measured(notes) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
