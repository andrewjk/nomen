import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// on_submit (docs/HANDLERS.md tier 2): Return-in-a-field as a registered
// event. The three single-line fields (TextBox, SecureField, SearchField)
// arm NSTextField's target/action in their constructors — it fires exactly
// on the USER commit (Return); programmatic set_text stays silent. The
// handler body pulls the committed text through get_text(). The poke
// dispatches each field's OWN action (sendAction:to:from: through NSApp),
// which exercises the arming: a nil action would no-op and the drain would
// never fire.
describe("on_submit family", () => {
	test("field commits dispatch registered handlers", { timeout: 300000 }, async () => {
		const input = `
import System
import System::Controls

mv struct SubmitApp : App {
	var TextBox name
	var SecureField secret
	var SearchField search
	var Text status
	var Container stack
	var int hits = 0
	var int frames = 0

	pub func #init = (self, Window window) {
		var TextBox name = TextBox(window)
		var SecureField secret = SecureField(window)
		var SearchField search = SearchField(window)
		var Text status = Text(window)
		status.set_text("idle")
		var Container stack = VStack(8)
		stack.add(name.handle, 0, 24, 1)
		stack.add(secret.handle, 0, 24, 1)
		stack.add(search.handle, 0, 24, 1)
		stack.add(status.handle, 0, 24, 1)
		// Locals are used up before the moves into fields (mv).
		self.name = name
		self.secret = secret
		self.search = search
		self.status = status
		self.stack = stack
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.stack)
		self.name.on_submit(func () {
			self.hits = self.hits + 1
		})
		self.secret.on_submit(func () {
			self.hits = self.hits + 1
		})
		self.search.on_submit(func () {
			self.hits = self.hits + 1
		})
	}

	// Dispatch each field's OWN action through NSApp — the exact call
	// AppKit makes when the user presses Return in the field. Proves the
	// arming: without the constructor's target/action the send no-ops.
	pub func poke = (ref self) {
		\`\`\`
		#arch: c
		#platform: macos
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		id f = (id)self->name.handle;
		((BOOL(*)(id, SEL, SEL, id, id))objc_msgSend)(nsapp, sel_registerName("sendAction:to:from:"),
			((SEL(*)(id, SEL))objc_msgSend)(f, sel_registerName("action")),
			((id(*)(id, SEL))objc_msgSend)(f, sel_registerName("target")),
			f);
		f = (id)self->secret.handle;
		((BOOL(*)(id, SEL, SEL, id, id))objc_msgSend)(nsapp, sel_registerName("sendAction:to:from:"),
			((SEL(*)(id, SEL))objc_msgSend)(f, sel_registerName("action")),
			((id(*)(id, SEL))objc_msgSend)(f, sel_registerName("target")),
			f);
		f = (id)self->search.handle;
		((BOOL(*)(id, SEL, SEL, id, id))objc_msgSend)(nsapp, sel_registerName("sendAction:to:from:"),
			((SEL(*)(id, SEL))objc_msgSend)(f, sel_registerName("action")),
			((id(*)(id, SEL))objc_msgSend)(f, sel_registerName("target")),
			f);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		id nsapp = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
		id f = (id)self->name.handle;
		((BOOL(*)(id, SEL, SEL, id, id))objc_msgSend)(nsapp, sel_registerName("sendAction:to:from:"),
			((SEL(*)(id, SEL))objc_msgSend)(f, sel_registerName("action")),
			((id(*)(id, SEL))objc_msgSend)(f, sel_registerName("target")),
			f);
		f = (id)self->secret.handle;
		((BOOL(*)(id, SEL, SEL, id, id))objc_msgSend)(nsapp, sel_registerName("sendAction:to:from:"),
			((SEL(*)(id, SEL))objc_msgSend)(f, sel_registerName("action")),
			((id(*)(id, SEL))objc_msgSend)(f, sel_registerName("target")),
			f);
		f = (id)self->search.handle;
		((BOOL(*)(id, SEL, SEL, id, id))objc_msgSend)(nsapp, sel_registerName("sendAction:to:from:"),
			((SEL(*)(id, SEL))objc_msgSend)(f, sel_registerName("action")),
			((id(*)(id, SEL))objc_msgSend)(f, sel_registerName("target")),
			f);
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
			self.poke()
		}
		// The commits landed during frame 2's body; the next frame's
		// handle_events drains all three records.
		if self.frames == 4 {
			Console.write_line("hits=\\{self.hits}")
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("on_submit", 320, 220)
	var SubmitApp app = SubmitApp(win)
	win.run(mv app)
}
`;
		await build_and_check_output(input, "gui_on_submit", "hits=3", true, {
			platform: "macos",
			audit: false,
		});
	});

	// Compile coverage for the handler-body form: the committed text rides
	// the control's existing get_text() — no new getters.
	test("handler bodies read the committed text through get_text", () => {
		const input = `
import System
import System::Controls

mv struct SearchApp : App {
	var SearchField search
	var Text status

	pub func #init = (self, Window window) {
		var SearchField search = SearchField(window)
		self.search = search
		var Text status = Text(window)
		status.set_text("idle")
		self.status = status
	}

	pub func start = (ref self, ref Window win) {
		self.search.on_submit(func () {
			self.status.set_text("search: \\{self.search.get_text()}")
		})
	}
}

pub func main = (Init init) {
	var Window win = Window("search_submit", 300, 160)
	var SearchApp app = SearchApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
