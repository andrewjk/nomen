import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// The on_select family (docs/HANDLERS.md): every selection-bearing control
// emits on_select. Two record feeds share one ring: the ACTION family
// (Select, Segmented, ComboBox — NSControl target/action, USER-driven only)
// and the DELEGATE family (Tabs, ListView, Table, OutlineView — selection
// delegates, which observe programmatic selection too). The handler body
// reads the payload through the control's own selected_index() /
// selected_row() — no new getters.
describe("on_select family", () => {
	test(
		"delegate + action selections dispatch registered handlers",
		{ timeout: 300000 },
		async () => {
			const input = `
import System
import System::Controls

mv struct SelectApp : App {
	var Tabs tabs
	var Table table
	var Segmented seg
	var Text status
	var Container stack
	var int hits = 0
	var int frames = 0

	pub func #init = (self, Window window) {
		var Tabs tabs = Tabs(window, 2)
		var Table table = Table(window, 2)
		table.set_header(0, "Item")
		table.set_header(1, "Qty")
		table.add_row()
		table.add_row()
		table.set_cell(0, 0, "apples")
		table.set_cell(1, 0, "pears")
		var Segmented seg = Segmented(window, 2)
		var Text status = Text(window)
		status.set_text("idle")
		var Container stack = VStack(8)
		stack.add(tabs.handle, 0, 80, 1, 1)
		stack.add(table.handle, 0, 80, 1, 1)
		stack.add(seg.handle, 0, 24, 1)
		stack.add(status.handle, 0, 24, 1)
		// Locals are used up before the moves into fields (mv).
		self.tabs = tabs
		self.table = table
		self.seg = seg
		self.status = status
		self.stack = stack
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.stack)
		self.tabs.on_select(func () {
			self.hits = self.hits + 1
		})
		self.table.on_select(func () {
			self.hits = self.hits + 1
		})
		self.seg.on_select(func () {
			self.hits = self.hits + 1
		})
	}

	// The segmented control's poke is raw-only (the aarch64 backend
	// replaces a use_c body wholesale — it cannot mix with statements).
	pub func poke_seg = (ref self) {
		\`\`\`
		#arch: c
		#platform: macos
		((void(*)(id, SEL, long))objc_msgSend)((id)self->seg.handle, sel_registerName("setSelectedSegment:"), 1);
		((void(*)(id, SEL, id))objc_msgSend)((id)self->seg.handle, sel_registerName("performClick:"), (id)0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		((void(*)(id, SEL, long))objc_msgSend)((id)self->seg.handle, sel_registerName("setSelectedSegment:"), 1);
		((void(*)(id, SEL, id))objc_msgSend)((id)self->seg.handle, sel_registerName("performClick:"), (id)0);
		\`\`\`
		\`\`\`
		#arch: c
		#platform: ios
		/* TODO: iOS */
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: ios
		/* TODO: iOS */
		\`\`\`
	}

	// Programmatic selection drives the DELEGATE family synchronously
	// (Tabs' didSelectTabViewItem, Table's tableViewSelectionDidChange
	// both observe it); performClick: drives the segmented control's
	// action the way a user click would.
	pub func poke = (ref self) {
		self.tabs.set_selected(1)
		self.table.select_row(1)
		self.poke_seg()
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			self.poke()
		}
		// The pokes landed during frame 2's body; the next frame's
		// handle_events drains all three records.
		if self.frames == 4 {
			Console.write_line("hits=\\{self.hits}")
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("on_select", 320, 400)
	var SelectApp app = SelectApp(win)
	win.run(mv app)
}
`;
			await build_and_check_output(input, "gui_on_select", "hits=3", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	// Compile coverage for the rest of the family: the drains exist, so the
	// registrations resolve (the runtime seam can't drive popup/combo
	// selections headlessly — they need a real menu tracking loop).
	test("Select and ComboBox registrations resolve", () => {
		const input = `
import System
import System::Controls

mv struct PickApp : App {
	var Select pick
	var ComboBox combo

	pub func #init = (self, Window window) {
		var Select pick = Select(window)
		pick.add_item("Red")
		self.pick = pick
		var ComboBox combo = ComboBox(window)
		combo.add_item("Green")
		self.combo = combo
	}

	pub func start = (ref self, ref Window win) {
		self.pick.on_select(func () {
			self.pick.selected_index()
		})
		self.combo.on_select(func () {
			self.combo.selected_index()
		})
	}
}

pub func main = (Init init) {
	var Window win = Window("pick", 300, 200)
	var PickApp app = PickApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
