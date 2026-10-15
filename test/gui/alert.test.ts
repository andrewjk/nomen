import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Tier 1 #19 (GUI_PLAN): Alert — NSAlert, window-coordinated (runModal
// blocks in its own modal loop, so it works with the manual loop). The
// runtime test exercises construction, text, and buttons; `run` itself is
// deliberately NOT called (it would block the test on dismissal).
describe("Alert control", () => {
	test(
		"title/message round trip + buttons",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Alert alert = Alert()
	Console.write("'\\{alert.title()}' \\{alert.button_count()}")
	alert.set_title("Delete todo?")
	alert.set_message("This cannot be undone.")
	alert.add_button("Delete")
	alert.add_button("Cancel")
	Console.write(" '\\{alert.title()}' '\\{alert.message()}' \\{alert.button_count()}")
	Console.write("\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(
				input,
				"gui_alert",
				"'' 1 'Delete todo?' 'This cannot be undone.' 2",
				true,
				{ platform: "macos", audit: false },
			);
		},
	);

	test("Alert conforms to the Control trait (through a Control receiver)", () => {
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
	var Alert alert = Alert()
	Console.write(framed(alert) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
