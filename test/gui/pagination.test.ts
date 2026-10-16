import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 3 compositions. Pagination clamps page state; the demo
// drives it from grid.contains hit-tests on the exposed handles.
describe("Pagination composition", () => {
	test("select/next/prev clamp to the page count", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("Pagination", 300, 120)
	var pag = Pagination(win, 3)
	pag.select(2)
	var int at = pag.page()
	pag.next()
	var int clamped = pag.page()
	pag.prev()
	pag.prev()
	pag.prev()
	var int floor = pag.page()
	Console.write("at=\\{at} clamp=\\{clamped} floor=\\{floor}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_pagination", "at=2 clamp=2 floor=0", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("handles resolve and spare page buttons hide", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("Pagination handles", 300, 120)
	var pag = Pagination(win, 2)
	var uint64 p1 = pag.page_handle(1)
	var uint64 p4 = pag.page_handle(4)
	Console.write("p1=\\{p1 != 0} spare=\\{p4 != 0} hidden=\\{pag.b4.is_hidden()}\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
		await build_and_check_output(input, "gui_pagination_handles", "p1=true spare=true hidden=true", true, {
			platform: "macos",
			audit: false,
		});
	});
});
