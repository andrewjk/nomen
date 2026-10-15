import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #13 (GUI_PLAN): ImageView — NSImageView / UIImageView. File path or
// named system symbol first; a failed load leaves the view empty.
describe("ImageView control", () => {
	test("set_symbol loads, a bad path clears, has_image reports", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("ImageView", 300, 300)
	var ImageView pic = ImageView(win)
	if pic.has_image() { Console.write("1") } else { Console.write("0") }
	pic.set_symbol("gearshape")
	if pic.has_image() { Console.write("1") } else { Console.write("0") }
	pic.set_path("/nonexistent/nomen/missing.png")
	if pic.has_image() { Console.write("1") } else { Console.write("0") }
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_image_view", "010", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("ImageView conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("ImageView trait", 300, 300)
	var ImageView pic = ImageView(win)
	Console.write(measured(pic) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
