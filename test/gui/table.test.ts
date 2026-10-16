import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: Table — multi-column NSTableView with VIEW-BASED
// reusable cells on macOS; no plain embeddable iOS counterpart, so those
// blocks are deferred TODO stubs. The bridge generalizes ListView's to a
// grid (row-major C-global cell pool, fixed column count); AppKit recycles
// the column-identified cell views through makeViewWithIdentifier as rows
// scroll. Named `Table` with no stdlib collision (the ListView `List<T>`
// lesson).
describe("Table control", () => {
	test("grid round-trips cells; selection is programmatically settable", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Table", 340, 200)
	var Table table = Table(win, 3)
	table.set_header(0, "Name")
	table.set_header(1, "Qty")
	table.set_header(2, "Price")
	table.add_row()
	table.add_row()
	table.set_cell(0, 0, "apples")
	table.set_cell(0, 1, "12")
	table.set_cell(0, 2, "0.40")
	table.set_cell(1, 0, "pears")
	const string c10 = table.cell(1, 0)
	Console.write("grid=\\{table.row_count()}x\\{table.col_count()} c10=\\{c10} ")
	table.select_row(1)
	Console.write("sel=\\{table.selected_row()} ")
	const string oob = table.cell(5, 5)
	Console.write("oob=\\{oob}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_table",
			"grid=2x3 c10=pears sel=1 oob=",
			true,
			{ platform: "macos", audit: false },
		);
	});

	test("remove_row shifts the tail rows; clear empties the grid", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Table shift", 340, 200)
	var Table table = Table(win, 2)
	table.add_row()
	table.add_row()
	table.add_row()
	table.set_cell(0, 0, "r0")
	table.set_cell(1, 0, "r1")
	table.set_cell(2, 0, "r2")
	table.remove_row(1)
	const string was_r2 = table.cell(1, 0)
	table.clear()
	Console.write("shift=\\{was_r2} rows=\\{table.row_count()}\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
		await build_and_check_output(input, "gui_table_shift", "shift=r2 rows=0", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("Table conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Table trait", 300, 200)
	var Table table = Table(win, 4)
	Console.write(measured(table) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
