import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// on_double_click (docs/HANDLERS.md tier 2): the list-row "open" gesture as
// a registered event — the sugar over the mouse-down record (left button,
// click count 2). Window-level and broadcast like on_right_click; the
// handler disambiguates through the dispatch window (win.click_x()/
// click_y() for hit-testing). `on_mouse_down` remains the raw tier and
// still sees the same event — both arms run (broadcast, no consumption).
//
// The double-click is synthesized at the AppKit seam: a CGEvent left
// mouse-down with kCGMouseEventClickState 2, posted into NSApp's queue —
// the NEXT frame's pump stamps the record and that frame's drains run
// (deterministic, as in the mouse_input test).
describe("on_double_click", () => {
	test(
		"double-clicks dispatch registered handlers; raw tier still sees them",
		{ timeout: 300000 },
		async () => {
			const input = `
import System
import System::Controls

mv struct OpenApp : App {
	var Text label
	var Container grid
	var int frames = 0

	pub func #init = (self, Window window) {
		var Text label = Text(window)
		label.set_text("idle")
		var Container grid = VStack(8)
		grid.add(label.handle, 0, 30, 1)
		// Locals are used up before the moves into fields (mv).
		self.label = label
		self.grid = grid
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
		self.grid.on_double_click(func () {
			// The sugar: the double-click edge, position through the
			// dispatch window for hit-testing.
			self.label.set_text("opened at \\{win.click_x()}")
		})
		self.grid.on_mouse_down(func () {
			// The raw tier still sees the same record (broadcast).
			self.label.set_text("down \\{win.mouse_click_count()}")
		})
	}

	pub func poke_double_click = (ref self, ref Window win) {
		\`\`\`
		#arch: c
		#platform: macos
		id w = (id)win->handle;
		id cv = ((id(*)(id, SEL))objc_msgSend)(w, sel_registerName("contentView"));
		CGRect f = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		CGEventRef cge = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, ((NSPoint){50.0, f.size.height - 12.0}), kCGMouseButtonLeft);
		CGEventSetIntegerValueField(cge, kCGMouseEventClickState, 2); // double-click
		id evt = ((id(*)(id, SEL, void *))objc_msgSend)(
			(id)objc_getClass("NSEvent"), sel_registerName("eventWithCGEvent:"), (void *)cge);
		CFRelease(cge);
		((void(*)(id, SEL, id, BOOL))objc_msgSend)(nsapp, sel_registerName("postEvent:atStart:"), evt, 0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		id w = (id)win->handle;
		id cv = ((id(*)(id, SEL))objc_msgSend)(w, sel_registerName("contentView"));
		CGRect f = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		CGEventRef cge = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, ((NSPoint){50.0, f.size.height - 12.0}), kCGMouseButtonLeft);
		CGEventSetIntegerValueField(cge, kCGMouseEventClickState, 2); // double-click
		id evt = ((id(*)(id, SEL, void *))objc_msgSend)(
			(id)objc_getClass("NSEvent"), sel_registerName("eventWithCGEvent:"), (void *)cge);
		CFRelease(cge);
		((void(*)(id, SEL, id, BOOL))objc_msgSend)(nsapp, sel_registerName("postEvent:atStart:"), evt, 0);
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

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			self.poke_double_click(ref win)
		}
		// The event lands in frame 3's pump; the arms run in registration
		// order, so the raw tier's write is what survives the frame.
		if self.frames == 3 {
			self.poke_double_click(ref win)
		}
		if self.frames == 4 {
			Console.write_line(self.label.get_text())
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("on_double_click", 320, 200)
	var OpenApp app = OpenApp(win)
	win.run(mv app)
}
`;
			// Frame 3's arms: on_double_click writes "opened at 50", then
			// on_mouse_down overwrites with "down 2" (registration order) —
			// both arms ran on one record.
			await build_and_check_output(input, "gui_on_double_click", "down 2", true, {
				platform: "macos",
				audit: false,
			});
		},
	);

	// Compile coverage for the handler-body form with hit-testing: the
	// position rides the dispatch window, so a list-row consumer can
	// resolve which row opened through Container.contains.
	test("handler bodies hit-test through the dispatch window", () => {
		const input = `
import System
import System::Controls

mv struct RowsApp : App {
	var Container rows
	var List<CheckBox> owned
	var List<uint64> handles
	var Text status

	pub func #init = (self, Window window) {
		var Container rows = VStack(0)
		var List<CheckBox> owned = List<CheckBox>()
		var List<uint64> handles = List<uint64>()
		var CheckBox row = CheckBox(window)
		row.set_title("row")
		rows.add(row.handle, 0, 24, 1)
		handles.push(row.handle)
		owned.push(mv row)
		// Locals are used up before the moves into fields (mv).
		self.rows = rows
		self.owned = owned
		self.handles = handles
		var Text status = Text(window)
		status.set_text("idle")
		self.status = status
	}

	pub func start = (ref self, ref Window win) {
		self.rows.on_double_click(func () {
			var i = 0
			while i < self.handles.length; i += 1 {
				if self.rows.contains(self.handles.at(i), win.click_x(), win.click_y()) {
					self.status.set_text("opened row \\{i}")
				}
			}
		})
	}
}

pub func main = (Init init) {
	var Window win = Window("rows_open", 320, 200)
	var RowsApp app = RowsApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
