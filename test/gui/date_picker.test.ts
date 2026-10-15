import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #14 (GUI_PLAN): DatePicker — NSDatePicker (clock+calendar style) /
// UIDatePicker. Values travel as epoch seconds; the round trip is exact.
describe("DatePicker control", () => {
	test(
		"epoch-seconds set / get round trip",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("DatePicker", 300, 200)
	var DatePicker picker = DatePicker(win)
	picker.set_time(1000000000)
	Console.write("\\{picker.time()}")
	picker.set_time(1234567890)
	Console.write(" \\{picker.time()}")
	Console.write("\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "gui_date_picker", "1000000000 1234567890", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	test("DatePicker conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("DatePicker trait", 300, 200)
	var DatePicker picker = DatePicker(win)
	Console.write(measured(picker) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
