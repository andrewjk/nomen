import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// GUI_PLAN Tier 2: Scrollable — NSScrollView + a document view on macOS; iOS
// deferred (TODO stubs). The document view answers `-contentView` with itself
// so control constructors and Container.layout work unchanged, and the
// engine's y-flip runs against the document height (see the Scrollable
// design note in GUI.md).
describe("Scrollable control", () => {
	test(
		"content_window hosts controls; scroll_to_top zeroes the offset",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var Window win = Window("Scrollable", 300, 200)
	var Scrollable scroll = Scrollable(win)
	const Window content = scroll.content_window()
	var grid = Grid(1, 6)
	grid.padding = 8
	var row_a = Text(content)
	row_a.set_text("Row A")
	var row_b = Text(content)
	row_b.set_text("Row B")
	var row_c = Text(content)
	row_c.set_text("Row C")
	var row_d = Text(content)
	row_d.set_text("Row D")
	var row_e = Text(content)
	row_e.set_text("Row E")
	var row_f = Text(content)
	row_f.set_text("Row F")
	var row_g = Text(content)
	row_g.set_text("Row G")
	var row_h = Text(content)
	row_h.set_text("Row H")
	grid.add(row_a.handle, 0, 24, 1)
	grid.add(row_b.handle, 0, 24, 1)
	grid.add(row_c.handle, 0, 24, 1)
	grid.add(row_d.handle, 0, 24, 1)
	grid.add(row_e.handle, 0, 24, 1)
	grid.add(row_f.handle, 0, 24, 1)
	grid.add(row_g.handle, 0, 24, 1)
	grid.add(row_h.handle, 0, 24, 1)
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 240
	const Size cs = grid.measure(bc)
	scroll.set_content_size(cs.width, cs.height)
	grid.layout(content)
	scroll.scroll_to_top()
	Console.write("scroll y=\\{scroll.scroll_offset_y()}\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "gui_scrollable", "scroll y=0", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	test("Scrollable conforms to the Control trait (measure / intrinsic_size)", () => {
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
	var Window win = Window("Scrollable trait", 300, 200)
	var Scrollable scroll = Scrollable(win)
	Console.write(measured(scroll) + "\\n")
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});

	test(
		"content_click translates window clicks into document coordinates",
		{ timeout: 120000 },
		async () => {
			const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("Scrollable clicks", 300, 200)
	var scroll = Scrollable(win)
	// 10 rows of 24 + 6px gaps (294 tall) in a 100-tall viewport, so the
	// document can scroll; the scroll view sits at the layout origin
	// (padding 0), so a click at (10, 20) is 20px below the visible top.
	var content = scroll.content_window()
	var grid = Grid(1, 6)
	var int made = 0
	while made < 10; made += 1 {
		var row = Text(content)
		row.set_text("Row")
		grid.add(row.handle, 0, 24, 1)
	}
	var root = Grid(1, 6)
	root.add(scroll.handle, 0, 100, 1)
	root.layout(win)
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 300
	const Size cs = grid.measure(bc)
	scroll.set_content_size(cs.width, cs.height)
	grid.layout(content)
	// Before scroll_to_top the document shows its bottom: the same window
	// click lands deeper into the content.
	var [bx, by] = content_click(scroll, 10, 20)
	const bool moved = by > 20
	Console.write("before_x=\\{bx} before_moved=\\{moved} ")
	scroll.scroll_to_top()
	var [ax, ay] = content_click(scroll, 10, 20)
	Console.write("after=\\{ax},\\{ay}\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(
				input,
				"gui_scrollable_clicks",
				"before_x=10 before_moved=true after=10,20",
				true,
				{ platform: "macos", audit: false },
			);
		},
	);

	test("short content clamps to the viewport (top-anchored)", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("Scrollable short", 300, 200)
	var scroll = Scrollable(win)
	var content = scroll.content_window()
	var grid = Grid(1, 8)
	var row_a = Text(content)
	row_a.set_text("A")
	var row_b = Text(content)
	row_b.set_text("B")
	var row_c = Text(content)
	row_c.set_text("C")
	grid.add(row_a.handle, 0, 24, 1)
	grid.add(row_b.handle, 0, 24, 1)
	grid.add(row_c.handle, 0, 24, 1)
	var root = Grid(1, 6)
	root.add(scroll.handle, 0, 100, 1)
	root.layout(win)
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 300
	const Size cs = grid.measure(bc)
	scroll.set_content_size(cs.width, cs.height)
	grid.layout(content)
	// A document shorter than its clip view would sit at the clip's BOTTOM
	// (the doc view is unflipped), rendering the list bunched at the bottom
	// of the scroll region. The clamp fills the viewport, so row A stays at
	// the top (y=0) of the document.
	Console.write("content=" + cs.height.to_string()
		+ " doc=" + content.content_height().to_string()
		+ " row=" + grid.fmt_frame(1) + "\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_scrollable_short",
			"content=88 doc=100 row=0,0,300,24",
			true,
			{ platform: "macos", audit: false },
		);
	});

	test("content controls hit-test through the click translation", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub func main = () {
	var win = Window("Scrollable hits", 400, 500)
	var scroll = Scrollable(win)
	var content = scroll.content_window()
	var todos = VStack(8)
	var handles = List<uint64>()
	var i = 0
	while i < 3; i += 1 {
		const cb = CheckBox(content)
		cb.set_title("todo")
		todos.add(cb.handle, 0, 24, 1)
		handles.push(cb.handle)
	}
	var Container grid = VStack(8)
	grid.padding = 16
	var title = Text(win)
	title.set_text("Todo List")
	const input = TextBox(win)
	const add_btn = Button(win, "Add")
	grid.add(title.handle, 0, 30, 1)
	grid.add(scroll.handle, 0, 0, 1, 1)
	const int input_row = grid.add_hstack(grid.root_index(), 8, 1)
	grid.add_to(input_row, input.handle, 0, 24, 1, 1)
	grid.add_to_intrinsic(input_row, add_btn.handle, 1)
	grid.layout(win)
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 400 - 32
	const Size cs = todos.measure(bc)
	scroll.set_content_size(cs.width, cs.height)
	todos.layout(content)
	win.show()
	scroll.scroll_to_top()
	// A click just below the scroll region's top edge lands on the first
	// todo (the controls were created against the DOCUMENT VIEW, so their
	// document coordinates are the real on-screen ones).
	const [tx, ty] = content_click(scroll, 100, 60)
	const bool hit0 = todos.contains(handles.at_or_panic(0), tx, ty)
	Console.write("doc=" + tx.to_string() + "," + ty.to_string()
		+ " hit0=" + hit0.to_string())
	// Grow past the viewport and re-anchor to the bottom: a click near the
	// region's bottom edge hits the LAST todo.
	var j = 0
	while j < 20; j += 1 {
		const cb = CheckBox(content)
		cb.set_title("more")
		todos.add(cb.handle, 0, 24, 1)
		handles.push(cb.handle)
	}
	grid.layout(win)
	const Size cs2 = todos.measure(bc)
	scroll.set_content_size(cs2.width, cs2.height)
	todos.layout(content)
	scroll.scroll_to_bottom()
	const [bx, by] = content_click(scroll, 100, 440)
	const bool hit_last = todos.contains(handles.at_or_panic(22), bx, by)
	Console.write(" doc=" + bx.to_string() + "," + by.to_string()
		+ " hit22=" + hit_last.to_string()
		+ " doc_h=" + content.content_height().to_string()
		+ " offset=" + scroll.scroll_offset_y().to_string() + "\\n")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"gui_scrollable_hits",
			"doc=84,6 hit0=true doc=84,716 hit22=true doc_h=728 offset=330",
			true,
			{ platform: "macos", audit: false },
		);
	});
});
