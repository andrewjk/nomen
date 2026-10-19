import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// Window.run — the App-contract run loop. A counting app closes its window
// on the third frame; `main` prints "done" after run returns. Proves: the
// loop pumps, App.start/frame dispatch through the moved-in conformer, the
// FrameEvents plumbing runs, Window.close exits the loop, and the app
// tears down cleanly (audit-checked on both backends).
describe("Window.run / App", () => {
	test("frame dispatch + close exits the loop", { timeout: 300000 }, async () => {
		const input = `
import System
import System::Controls

mv struct CountApp : App {
	var Text label
	var int frames = 0

	pub func #init = (self, Window window) {
		self.label = Text(window)
		self.label.set_text("0")
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		var string s = self.frames.to_string()
		self.label.set_text(s)
		if self.frames == 3 {
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("App run", 200, 100)
	var CountApp app = CountApp(win)
	win.run(mv app)
	Console.write_line("done")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_app_run", "done", true, {
			platform: "macos",
			audit: false,
		});
	});

	// The resize path: an app that records FrameEvents.resized. set_size
	// changes the content rect between frames; the framework relayouts the
	// registered roots and the app observes one resize event.
	test("resize event fires once per size change", { timeout: 300000 }, async () => {
		const input = `
import System
import System::Controls

mv struct ResizeApp : App {
	var Text label
	var int resizes = 0
	var int frames = 0

	pub func #init = (self, Window window) {
		self.label = Text(window)
		self.label.set_text("0")
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			win.set_size(300, 200)
		}
		if ev.resized {
			self.resizes = self.resizes + 1
		}
		if self.frames == 5 {
			var string s = self.resizes.to_string()
			self.label.set_text(s)
			Console.write_line("resizes \\{s}")
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("App resize", 200, 100)
	var ResizeApp app = ResizeApp(win)
	win.run(mv app)
	Console.write_line("done")
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "gui_app_resize", "resizes 1\ndone", true, {
			platform: "macos",
			audit: false,
		});
	});

	// The layout contract: the root registered via set_content is laid out
	// by the framework (label fills the window width, y-flipped against the
	// content height), and RE-laid out after a resize. native_frame reads
	// AppKit's answer so the assertion covers the whole path.
	test("set_content root is laid out and re-laid out on resize", { timeout: 300000 }, async () => {
		const input = `
import System
import System::Controls

mv struct ProbeApp : App {
	var Text label
	var Container grid
	var int frames = 0

	pub func #init = (self, Window window) {
		self.label = Text(window)
		self.label.set_text("probe")
		var Container g = VStack(0)
		g.add(self.label.handle, 0, 24, 1)
		self.grid = g
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			win.set_size(300, 200)
		}
		if self.frames == 4 {
			Console.write_line(native_frame(self.label.handle))
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("App layout", 200, 100)
	var ProbeApp app = ProbeApp(win)
	win.run(mv app)
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		// VStack root fills the window: label at y = content_h - 24,
		// stretched to the full width. After the resize to 300x200: y = 176.
		await build_and_check_output(input, "gui_app_layout", "0,176,300,24", true, {
			platform: "macos",
			audit: false,
		});
	});
});
