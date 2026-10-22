import path from "node:path";

import { expect, describe, test } from "vite-plus/test";

import { get_library } from "../../src/lib";
import parse from "../../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../../core"));

// The `.on_<event>(closure)` desugar's checker rules (docs/HANDLERS.md,
// "Checker rules") — one clear error each. The happy path is exercised by
// the runtime test (gui/on_click.test.ts); these pin the rejection shapes.

// A canonical host: the registration sites below swap in per rule.
const HOST_PRELUDE = `
import System
import System::Controls

mv struct ClickApp : App {
	var Button btn

	pub func #init = (self, Window window) {
		self.btn = Button(window, "Go")
	}

	pub func start = (ref self, ref Window win) {
		${"REGISTRATION"}
	}
}

pub func main = (Init init) {
	var Window win = Window("handlers", 200, 140)
	var ClickApp app = ClickApp(win)
	win.run(mv app)
}
`;

function check_with_registration(registration: string) {
	const input = HOST_PRELUDE.replace("REGISTRATION", registration);
	return parse(input, system).errors.map((e) => e.message);
}

describe("on_click checker rules", () => {
	test("valid registration produces no errors", () => {
		expect(check_with_registration(`self.btn.on_click(func () { })`)).toEqual([]);
	});

	test("receiver must be a self-rooted field path", () => {
		// A local receiver has nothing for the dispatch arm to re-evaluate.
		const input = `
import System
import System::Controls

mv struct ClickApp : App {
	var Button btn

	pub func #init = (self, Window window) {
		self.btn = Button(window, "Go")
	}

	pub func start = (ref self, ref Window win) {
		var Button local = Button(win, "Local")
		local.on_click(func () { })
	}
}

pub func main = (Init init) {
	var Window win = Window("handlers", 200, 140)
	var ClickApp app = ClickApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors.map((e) => e.message)).toEqual([
			".on_click needs a self-rooted field receiver — store the control in a field and register from self.<field>.on_click(...): the dispatch arm re-evaluates the path, so a local receiver has nothing to re-evaluate",
		]);
	});

	test("handler closures take no parameters", () => {
		expect(check_with_registration(`self.btn.on_click(func (int n) { })`)).toEqual([
			"handler closures take no parameters — the body sees `self` and the dispatch `win`",
		]);
	});

	test("no upvalue captures — outer locals are rejected", () => {
		const input = `
import System
import System::Controls

mv struct ClickApp : App {
	var Button btn

	pub func #init = (self, Window window) {
		self.btn = Button(window, "Go")
	}

	pub func start = (ref self, ref Window win) {
		var int clicks = 0
		self.btn.on_click(func () {
			clicks = clicks + 1
		})
	}
}

pub func main = (Init init) {
	var Window win = Window("handlers", 200, 140)
	var ClickApp app = ClickApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors.map((e) => e.message)).toEqual([
			"handler closures see `self` and the dispatch `win` — copy what you need into fields",
		]);
	});

	test("host reachability — non-App hosts cannot register", () => {
		const input = `
import System
import System::Controls

mv struct NotAnApp {
	var Button btn

	pub func #init = (self, Window window) {
		self.btn = Button(window, "Go")
	}

	pub func start = (ref self, ref Window win) {
		self.btn.on_click(func () { })
	}
}

pub func main = (Init init) {
	var Window win = Window("handlers", 200, 140)
	var NotAnApp app = NotAnApp(win)
}
`;
		expect(parse(input, system).errors.map((e) => e.message)).toEqual([
			"handlers dispatch from the run root — 'NotAnApp' is not owned by the app",
		]);
	});

	// Stage 2 (HANDLERS.md "Handler hosts beyond the root"): a composite the
	// app owns is a handler host in its own right — the dispatch forwards
	// down the static field path, so the registration is accepted.
	test("composite host reachable from the app is accepted", () => {
		const input = `
import System
import System::Controls

mv struct MyPager {
	var Button prev
	var Button next
	var int page = 0

	pub func #init = (self, Window window) {
		self.prev = Button(window, "<")
		self.next = Button(window, ">")
		self.prev.on_click(func () { self.page = self.page - 1 })
		self.next.on_click(func () { self.page = self.page + 1 })
	}
}

mv struct PagerApp : App {
	var MyPager pager

	pub func #init = (self, Window window) {
		self.pager = MyPager(window)
	}
}

pub func main = (Init init) {
	var Window win = Window("my_pager", 200, 160)
	var PagerApp app = PagerApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});

	// Forwarding is transitive: App -> Middle (no handlers of its own) ->
	// Leaf (registers). Middle synthesizes a pure-forwarding handle_events.
	test("transitive host chains forward through intermediate structs", () => {
		const input = `
import System
import System::Controls

mv struct Leaf {
	var Button btn

	pub func #init = (self, Window window) {
		self.btn = Button(window, "Go")
		self.btn.on_click(func () { })
	}
}

mv struct Middle {
	var Leaf leaf

	pub func #init = (self, Window window) {
		self.leaf = Leaf(window)
	}
}

mv struct ChainApp : App {
	var Middle middle

	pub func #init = (self, Window window) {
		self.middle = Middle(window)
	}
}

pub func main = (Init init) {
	var Window win = Window("chain", 200, 160)
	var ChainApp app = ChainApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});

	// Stage 3 — id up-calls: a composite declares the event API (a method
	// taking the dispatch id), and the app-side registration hoists the
	// handler onto the app, synthesizes `run_handler`, and rewrites the site
	// to the enrollment call.
	test("composite event registration enrolls an up-call handler", () => {
		const input = `
import System
import System::Controls

mv struct MyPager {
	var Button next
	var int page = 0
	var int page_change_id = -1
	var bool page_change_pending = false

	pub func #init = (self, Window window) {
		self.next = Button(window, ">")
	}

	pub func on_page_change = (ref self, int id) {
		self.page_change_id = id
	}

	pub func tick = (ref self, ref App owner, ref Window win) {
		if self.page_change_pending && self.page_change_id >= 0 {
			owner.run_handler(self.page_change_id, ref win)
		}
		self.page_change_pending = false
	}
}

mv struct PagerApp : App {
	var MyPager pager

	pub func #init = (self, Window window) {
		self.pager = MyPager(window)
	}

	pub func start = (ref self, ref Window win) {
		self.pager.on_page_change(func () { })
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.pager.tick(ref self, ref win)
	}
}

pub func main = (Init init) {
	var Window win = Window("pager", 200, 160)
	var PagerApp app = PagerApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});

	// Without the composite's declared event API, the name resolves
	// ordinarily — the family is reserved on controls, not on composites.
	test("composite event without a declared API is a plain missing function", () => {
		const input = `
import System
import System::Controls

mv struct MyBox {
	var Button btn

	pub func #init = (self, Window window) {
		self.btn = Button(window, "Go")
	}
}

mv struct BoxApp : App {
	var MyBox box

	pub func #init = (self, Window window) {
		self.box = MyBox(window)
	}

	pub func start = (ref self, ref Window win) {
		self.box.on_frobnicate(func () { })
	}
}

pub func main = (Init init) {
	var Window win = Window("box", 200, 160)
	var BoxApp app = BoxApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors.map((e) => e.message)).toEqual([
			"'MyBox' doesn't emit on_frobnicate events (no take_frobnicate drain)",
		]);
	});

	// The up-call dispatches through the APP's run_handler — a composite
	// cannot register an event handler on another composite.
	test("composite events register from the app only", () => {
		const input = `
import System
import System::Controls

mv struct Leaf {
	var Button btn

	pub func #init = (self, Window window) {
		self.btn = Button(window, "Go")
	}

	pub func on_page_change = (ref self, int id) {
	}
}

mv struct Wrapper {
	var Leaf leaf
	var int seen = 0

	pub func #init = (self, Window window) {
		self.leaf = Leaf(window)
	}

	pub func arm = (ref self, ref Window win) {
		self.leaf.on_page_change(func () { })
	}
}

mv struct ChainApp : App {
	var Wrapper wrapper

	pub func #init = (self, Window window) {
		self.wrapper = Wrapper(window)
	}
}

pub func main = (Init init) {
	var Window win = Window("chain", 200, 160)
	var ChainApp app = ChainApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors.map((e) => e.message)).toEqual([
			"up-call handlers dispatch through the app's run_handler — register .on_page_change from the app, not from 'Wrapper'",
		]);
	});

	// run_handler is the desugar's synthesized dispatch — a user declaration
	// collides with it on an enrolling app.
	test("run_handler is reserved on apps with up-call handlers", () => {
		const input = `
import System
import System::Controls

mv struct MyPager {
	var Button next

	pub func #init = (self, Window window) {
		self.next = Button(window, ">")
	}

	pub func on_page_change = (ref self, int id) {
	}
}

mv struct PagerApp : App {
	var MyPager pager

	pub func #init = (self, Window window) {
		self.pager = MyPager(window)
	}

	pub func run_handler = (ref self, int id, ref Window win) {
	}

	pub func start = (ref self, ref Window win) {
		self.pager.on_page_change(func () { })
	}
}

pub func main = (Init init) {
	var Window win = Window("pager", 200, 160)
	var PagerApp app = PagerApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors.map((e) => e.message)).toEqual([
			"'PagerApp' already declares run_handler — the .on_page_change desugar synthesizes it (the name is reserved on the app)",
		]);
	});

	test("unsupported events name the control's missing drain", () => {
		expect(check_with_registration(`self.btn.on_hover(func () { })`)).toEqual([
			"'Button' doesn't emit on_hover events (no take_hover drain)",
		]);
	});

	test("handle_events is reserved on handler hosts", () => {
		const input = `
import System
import System::Controls

mv struct ClickApp : App {
	var Button btn

	pub func #init = (self, Window window) {
		self.btn = Button(window, "Go")
	}

	pub func handle_events = (ref self, ref Window win) {
	}

	pub func start = (ref self, ref Window win) {
		self.btn.on_click(func () { })
	}
}

pub func main = (Init init) {
	var Window win = Window("handlers", 200, 140)
	var ClickApp app = ClickApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors.map((e) => e.message)).toEqual([
			"'ClickApp' already declares handle_events — the .on_click desugar synthesizes it (the name is reserved on handler hosts)",
		]);
	});

	test("non-control receivers resolve ordinarily (function not found)", () => {
		const input = `
import System

mv struct Plain {
	var int n = 0

	pub func start = (ref self) {
		self.n.on_click(func () { })
	}
}
`;
		expect(parse(input, system).errors.map((e) => e.message)).toEqual([
			"'int' doesn't emit on_click events (no take_click drain)",
		]);
	});

	// Event routing precedence (docs/HANDLERS.md): a DECLARED event API wins
	// over the builtin table — even on a Control-conforming composite, and
	// even for the name on_click. A voice-only (non-GUI) widget declares its
	// own events the same way; nothing in the desugar is click-specific.
	test("Control-conforming composite with a declared API routes composite", () => {
		const input = `
import System
import System::Controls

mv struct MyPager : Control {
	var Button prev
	var Button next
	var int page = 0
	var int page_change_id = -1
	var bool page_change_pending = false

	pub func #init = (self, Window window) {
		self.prev = Button(window, "<")
		self.next = Button(window, ">")
	}

	pub func measure = (self, BoxConstraints constraints, out Size) {
		var s = Size()
		s.width = 120
		s.height = 24
		return s
	}

	pub func set_frame = (ref self, int x, int y, int width, int height) {
	}

	pub func intrinsic_size = (self, out Size) {
		var s = Size()
		s.width = 120
		s.height = 24
		return s
	}

	pub func on_page_change = (ref self, int id) {
		self.page_change_id = id
	}

	pub func tick = (ref self, ref App owner, ref Window win) {
		if self.page_change_pending && self.page_change_id >= 0 {
			owner.run_handler(self.page_change_id, ref win)
		}
		self.page_change_pending = false
	}
}

mv struct PagerApp : App {
	var MyPager pager

	pub func #init = (self, Window window) {
		self.pager = MyPager(window)
	}

	pub func start = (ref self, ref Window win) {
		self.pager.on_page_change(func () { })
	}
}

pub func main = (Init init) {
	var Window win = Window("pager", 200, 160)
	var PagerApp app = PagerApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});

	// on_click itself is composite-eligible: a widget that declares
	// `on_click(id)` owns its own click source (e.g. a custom-drawn or
	// voice-activated control) and the desugar routes through enrollment —
	// the builtin table is only the Control-receiver default.
	test("declared on_click API on a custom widget routes composite", () => {
		const input = `
import System
import System::Controls

mv struct VoiceButton {
	var int press_id = -1
	var bool press_pending = false

	pub func on_click = (ref self, int id) {
		self.press_id = id
	}

	pub func tick = (ref self, ref App owner, ref Window win) {
		if self.press_pending && self.press_id >= 0 {
			owner.run_handler(self.press_id, ref win)
		}
		self.press_pending = false
	}

	pub func heard = (ref self) {
		self.press_pending = true
	}
}

mv struct VoiceApp : App {
	var VoiceButton mic
	var Text status
	var Container grid
	var int heard = 0
	var int frames = 0

	pub func #init = (self, Window window) {
		self.mic = VoiceButton()
		self.status = Text(window)
		var Container grid = VStack(8)
		grid.add(self.status.handle, 0, 24, 1)
		self.grid = grid
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
		self.mic.on_click(func () { self.heard = self.heard + 1 })
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			self.mic.heard()
		}
		if self.frames == 3 {
			Console.write_line(self.heard.to_string())
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("voice", 200, 160)
	var VoiceApp app = VoiceApp(win)
	win.run(mv app)
}
`;
		expect(parse(input, system).errors).toEqual([]);
	});
});
