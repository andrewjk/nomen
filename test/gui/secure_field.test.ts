import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #7 (GUI_PLAN): SecureField — NSSecureTextField / UITextField
// secureTextEntry. Passwords; a distinct native class from NSTextField, so a
// distinct control. The runtime test proves the VALUE is readable back even
// though the platform masks the display.
describe("SecureField control", () => {
	test("set_text / get_text round trip on the masked value", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("SecureField", 300, 200)
	var SecureField pw = SecureField(win)
	Console.write(pw.get_text())
	pw.set_text("hunter2")
	Console.write(" \\{pw.get_text()}")
	pw.set_text("")
	Console.write(" \\{pw.get_text()}")
	Console.write("\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_secure_field", " hunter2 ", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("SecureField conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("SecureField trait", 300, 200)
	var SecureField pw = SecureField(win)
	Console.write(measured(pw) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
