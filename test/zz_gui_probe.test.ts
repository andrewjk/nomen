import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

test("pilot step 6: Text through trait local", async () => {
	const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("pilot", 400, 300)
	var Text title = Text(win)
	title.set_text("hello")
	var Control c = title
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 800
	bc.max_height = 600
	var Size s = c.measure(bc)
	Console.write("\\{s.width}")
	Console.write_line("x")
}
`;
	await build_and_check_output(input, "gui_pilot7", "", true, { platform: "macos", audit: false });
});
