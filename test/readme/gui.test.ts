import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("readme: GUI", () => {
	test("window, text, and show", () => {
		const input = `
import System/Controls

pub func main = () {
    var Window win = Window("Nomen", 400, 300)
    var Text title = Text(win)
    title.set_text("Hello")
    win.show()
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
