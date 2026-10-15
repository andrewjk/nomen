import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: ComboBox — NSComboBox (editable + completing) on macOS;
// no iOS counterpart, so those blocks are deferred TODO stubs. Items live
// in the combo box's internal list; text and selection are polled like
// every other control in the manual loop.
describe("ComboBox control", () => {
	test("items, selection, and free text round-trip", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("ComboBox", 260, 120)
	var ComboBox combo = ComboBox(win)
	combo.add_item("Red")
	combo.add_item("Green")
	combo.add_item("Blue")
	const string second = combo.item(1)
	Console.write("count=\\{combo.item_count()} item1=\\{second} ")
	combo.set_selected(2)
	Console.write("sel=\\{combo.selected_index()} ")
	combo.set_text("custom")
	const string text = combo.get_text()
	Console.write("text=\\{text} sel=\\{combo.selected_index()}\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_combo_box",
			"count=3 item1=Green sel=2 text=custom sel=2",
			true,
			{ platform: "macos", audit: false },
		);
	});

	test("remove_all empties the item list", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("ComboBox clear", 260, 120)
	var ComboBox combo = ComboBox(win)
	combo.add_item("One")
	combo.add_item("Two")
	combo.remove_all()
	Console.write("count=\\{combo.item_count()}\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
		await build_and_check_output(input, "gui_combo_box_clear", "count=0", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("ComboBox conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("ComboBox trait", 300, 200)
	var ComboBox combo = ComboBox(win)
	Console.write(measured(combo) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
