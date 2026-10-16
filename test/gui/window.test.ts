import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// The Window control's trait-conformance `set_frame` sent `setFrame:` — an
// NSView selector an NSWindow doesn't respond to (the window API is
// `setFrame:display:`), so calling it raised "unrecognized selector" and
// resizing a window programmatically was impossible. This also gives the
// resize paths a way to be exercised headlessly.
describe("Window control", () => {
	test("set_frame resizes the window", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("Window resize", 400, 500)
	win.show()
	Console.write("before=" + win.content_height().to_string())
	win.set_frame(100, 60, 400, 600)
	Console.write(" after=" + win.content_height().to_string() + "\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_window_resize", "before=500 after=568", true, {
			platform: "macos",
			audit: false,
		});
	});
});
