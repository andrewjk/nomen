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
	// Leaf (registers). Middle synthesizes a pure-forwarding handle_clicks.
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

	test("unsupported events name the one supported form", () => {
		expect(check_with_registration(`self.btn.on_hover(func () { })`)).toEqual([
			".on_hover is not a supported handler event yet — only on_click is implemented",
		]);
	});

	test("handle_clicks is reserved on handler hosts", () => {
		const input = `
import System
import System::Controls

mv struct ClickApp : App {
	var Button btn

	pub func #init = (self, Window window) {
		self.btn = Button(window, "Go")
	}

	pub func handle_clicks = (ref self, ref Window win) {
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
			"'ClickApp' already declares handle_clicks — the .on_click desugar synthesizes it (the name is reserved on handler hosts)",
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
			"Function not found: int.on_click",
		]);
	});
});
