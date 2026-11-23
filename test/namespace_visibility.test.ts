import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

/**
 * Namespace-scoped visibility (docs/SCOPING.md). Each scenario is the
 * compile-checked probe from the SCOPING audit: single-file programs go
 * through parse + the real System library directly; the multi-file ones
 * inject `// file://` markers (exactly what the joiner emits) so
 * declarations land in different namespaces.
 */
const core = path.resolve(import.meta.dirname, "../core");

function errors_of(source: string, file_path?: string) {
	return parse(source, get_library(core), file_path).errors.map((e) => e.message);
}

describe("namespace visibility", () => {
	test("no import at all: library names unknown", () => {
		const errors = errors_of(`
pub func main = () {
	var Size s = Size()
}
`);
		// Without `import System` nothing is linked — unknown, not scoping.
		expect(errors.some((m) => m.includes("Unknown type: Size"))).toBe(true);
	});

	test("P1: qualified Controls ref with only `import System` is gated", () => {
		const errors = errors_of(`
import System

pub func main = () {
	var s = Controls::Size()
	s.width = 10
	Console.write_line(s.width.to_string())
}
`);
		expect(errors.length).toBe(1);
		expect(errors[0]).toBe("Namespace System::Controls is not imported");
	});

	test("P2: bare Controls type with only `import System` is gated", () => {
		const errors = errors_of(`
import System

pub func main = () {
	var s = Size()
	s.width = 10
	Console.write_line(s.width.to_string())
}
`);
		// Per-item gating: the constructor and each field access report.
		expect(errors).toEqual([
			"Namespace System::Controls is not imported: Size",
			"Namespace System::Controls is not imported: width",
			"Namespace System::Controls is not imported: width",
		]);
	});

	test("P8: cross-namespace reach through one unrelated import is gated", () => {
		const errors = errors_of(`
import System
import System::Controls

pub func main = () {
	if Text::Regex.test("a", "abc") {
		Console.write_line("yes")
	}
}
`);
		expect(errors.length).toBe(1);
		expect(errors[0]).toBe("Namespace System::Text is not imported");
	});

	test("importing the namespace grants its names (module-file import too)", () => {
		const ok1 = errors_of(`
import System
import System::Controls

pub func main = () {
	var s = Size()
	s.width = 10
	Console.write_line(s.width.to_string())
}
`);
		expect(ok1).toEqual([]);
		const ok2 = errors_of(`
import System
import System::Text

pub func main = () {
	if Regex.test("a", "abc") {
		Console.write_line("yes")
	}
}
`);
		expect(ok2).toEqual([]);
	});

	test("P3: internal members stay closed to consumers", () => {
		const errors = errors_of(`
import System

pub func main = () {
	var sb = StringBuilder()
	sb.seed("hi")
	sb.ensure(100)
	var b = Buffer<int>()
	Console.write_line(sb.to_string())
	Console.write_line(b.data.to_string())
}
`);
		expect(errors).toContain("Can't access internal function: ensure");
		expect(errors).toContain("Can't access internal field: data");
	});

	test("P7: bare library helpers are not callable from user code", () => {
		const errors = errors_of(`
import System
import System::Text

pub func main = () {
	var a = is_alpha_byte('q')
	Console.write_line(a.to_string())
}
`);
		expect(errors).toContain("Can't access private function: is_alpha_byte");
	});

	test("P4: a child namespace never imported stays unknown", () => {
		const dir = "/virtual/proj";
		const main = `// file://${dir}/main.nm
pub func main = () {
	var w = Widget()
	Console.write_line(w.count().to_string())
}
// file://${dir}/Blah/Widget.nm
internal struct Widget {
	var clicks = 0
	pub func count = (self, out int) {
		return self.clicks
	}
}
`;
		// No import of Blah → the joiner would not even inline it; with the
		// file stamped but unimported, the name stays gated.
		const errors = parse(main, get_library(core), `${dir}/main.nm`).errors.map((e) => e.message);
		expect(errors.some((m) => m.includes("Widget"))).toBe(true);
	});

	test("P5: an imported sibling namespace's internals stay closed", () => {
		const dir = "/virtual/proj";
		const main = `// file://${dir}/main.nm
import System
import Blah

pub func main = () {
	var w = Widget()
	w.bump()
	Console.write_line(widget_helper().to_string())
	var s = Secret()
	s.value = 3
	Console.write_line(s.value.to_string())
}
// file://${dir}/Blah/Widget.nm
internal struct Widget {
	var clicks = 0
	internal func bump = (ref self {}) {
		self.clicks += 1
	}
	pub func count = (self, out int) {
		return self.clicks
	}
}
struct Secret {
	var value = 0
}
internal func widget_helper = (out int) {
	return 7
}
`;
		const errors = parse(main, get_library(core), `${dir}/main.nm`).errors.map((e) => e.message);
		expect(errors).toContain("Can't access internal function: Widget");
		expect(errors).toContain("Can't access internal function: bump");
		expect(errors).toContain("Can't access private function: Secret");
		expect(errors).toContain("Can't access internal function: widget_helper");
	});

	test("P5b: a sibling namespace's pub surface works through the import", () => {
		const dir = "/virtual/proj";
		const main = `// file://${dir}/main.nm
import System
import Blah

pub func main = () {
	var w = Widget()
	w.bump()
	Console.write_line(w.count().to_string())
	Console.write_line(widget_pub().to_string())
}
// file://${dir}/Blah/Widget.nm
import System

pub struct Widget {
	var clicks = 0
	pub func bump = (ref self {}) {
		self.clicks += 1
	}
	pub func count = (self, out int) {
		return self.clicks
	}
}
pub func widget_pub = (out int) {
	return 7
}
`;
		const errors = parse(main, get_library(core), `${dir}/main.nm`).errors.map((e) => e.message);
		expect(errors).toEqual([]);
	});

	test("P6: parent namespace pub + internal visible; bare stays home", () => {
		const dir = "/virtual/proj";
		const widget = `// file://${dir}/Blah/widget.nm
internal func probe_parent = (out int) {
	return parent_pub() + parent_internal()
}
// file://${dir}/parent.nm
pub func parent_pub = (out int) {
	return 1
}
internal func parent_internal = (out int) {
	return 2
}
func parent_bare = (out int) {
	return 3
}
`;
		const errors = parse(widget, get_library(core), `${dir}/Blah/widget.nm`).errors.map(
			(e) => e.message,
		);
		expect(errors).toEqual([]);
	});

	test("a child namespace sees its parent's internals, but not System's", () => {
		const dir = "/virtual/proj";
		const src = `// file://${dir}/src/Blah/widget.nm
import System

func uses_parent = (out int) {
	var sb = StringBuilder()
	sb.seed("hi")
	sb.ensure(64)
	return entry_internal()
}
// file://${dir}/src/main.nm
import System

internal func entry_internal = (out int) {
	return 5
}

pub func main = () {}
`;
		// `Blah` is a child of the entry namespace (""), so the entry's
		// `internal` helper is an ancestor's internal — visible. `System`
		// internals are NOT: System is not in the user namespace chain at
		// all, so StringBuilder.ensure stays closed even through the import.
		const errors = parse(src, get_library(core), `${dir}/src/main.nm`).errors.map((e) => e.message);
		expect(errors).toEqual(["Can't access internal function: ensure"]);
	});

	test("same-namespace bare declarations are visible across files", () => {
		const dir = "/virtual/proj";
		const src = `// file://${dir}/main.nm
import System

pub func main = () {
	Console.write_line(helper().to_string())
}
// file://${dir}/helper.nm
import System

func helper = (out int) {
	return 41
}
`;
		const errors = parse(src, get_library(core), `${dir}/main.nm`).errors.map((e) => e.message);
		expect(errors).toEqual([]);
	});

	test("an internal library type may not be named by user code", () => {
		// There is no internal top-level TYPE in the library, so synthesize
		// the situation with a user-side internal type in another namespace.
		const dir = "/virtual/proj";
		const src = `// file://${dir}/main.nm
import System
import Blah

pub func main = () {
	var Widget w = Widget()
	Console.write_line(w.count().to_string())
}
// file://${dir}/Blah/Widget.nm
import System

internal struct Widget {
	var clicks = 0
	pub func count = (self, out int) {
		return self.clicks
	}
}
`;
		const errors = parse(src, get_library(core), `${dir}/main.nm`).errors.map((e) => e.message);
		expect(errors).toEqual(["Can't access internal type: Widget"]);
	});
});
