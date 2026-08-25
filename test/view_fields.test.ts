import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

// `view T` struct fields — non-owning (ptr, len) slices stored inside struct
// instances ("borrow-into-parent": many small records referencing slices of
// one long-lived buffer). The field is a plain 16-byte pair: byte-copying a
// struct copies the borrow (sound), and nothing is freed on destroy (the
// field owns nothing). Escape hazards are checked at compile time: an
// instance whose view fields borrow from this scope may not be returned
// (unless every borrow roots at `self`), and mutating a borrow source
// invalidates the fields until they are re-pointed.
//
// Runtime tests build and execute on BOTH backends (C and aarch64), with the
// leak auditor on — a view field must never be freed.

const LINE = `
struct Line {
	var view string text
	var int start = 0
}
`;

describe("view struct fields (runtime, both backends)", () => {
	test("constructor stores a borrowed slice", async () => {
		await build_and_check_output(
			`
${LINE}
var string doc = "hello world"
if doc.length == 11 {
	var Line line = Line(doc.slice(0, 5))
	Console.write("\\{line.text.length}")
	Console.write(line.text.to_string())
	Console.write(line.text.at(1).to_string())
}
`,
			"view_field_ctor",
			"5helloe",
		);
	});

	test("defaulted view field (empty literal)", async () => {
		await build_and_check_output(
			`
struct Span {
	var view string text = ""
	var int start = 0
	var int len = 0
}
var string doc = "hello"
if doc.length == 5 {
	var Span s = Span()
	s.text = doc.slice(1, 4)
	Console.write(s.text.to_string())
}
`,
			"view_field_default",
			"ell",
		);
	});

	test("field reassignment re-points the borrow", async () => {
		await build_and_check_output(
			`
${LINE}
var string doc = "hello world"
if doc.length == 11 {
	var Line line = Line(doc.slice(0, 5))
	line.text = doc.slice(6, 11)
	Console.write(line.text.to_string())
	Console.write("\\{line.text.length}")
}
`,
			"view_field_reassign",
			"world5",
		);
	});

	test("length on a view field", async () => {
		await build_and_check_output(
			`
${LINE}
var string doc = "abcdef"
if doc.length == 6 {
	var Line line = Line(doc.slice(2, 6))
	Console.write("\\{line.text.length}")
}
`,
			"view_field_length",
			"4",
		);
	});

	test("struct copy copies the borrow", async () => {
		await build_and_check_output(
			`
${LINE}
var string doc = "hello"
if doc.length == 5 {
	var Line a = Line(doc.slice(1, 4))
	var Line b = a
	b.text = a.text
	Console.write(b.text.to_string())
	Console.write("\\{b.start}")
}
`,
			"view_field_copy",
			"ell0",
		);
	});

	test("borrow-into-parent: many records over one buffer", async () => {
		await build_and_check_output(
			`
${LINE}
var string doc = "aa bb cc"
if doc.length == 8 {
	var List<Line> lines = List<Line>()
	lines.push(Line(doc.slice(0, 2)))
	lines.push(Line(doc.slice(3, 5)))
	lines.push(Line(doc.slice(6, 8)))
	var int i = 0
	while i < lines.length {
		var Line l = lines.at(i)
		Console.write(l.text.to_string())
		i = i + 1
	}
}
`,
			"view_field_list",
			"aabbcc",
		);
	});

	test("method returning a self-rooted view field", async () => {
		await build_and_check_output(
			`
struct Token {
	var view string src

	pub func head = (self, out view string) {
		return self.src
	}
}
var string doc = "xyz"
if doc.length == 3 {
	var Token t = Token(doc.slice(1, 3))
	Console.write(t.src.to_string())
	Console.write(t.head().to_string())
}
`,
			"view_field_method",
			"yzyz",
		);
	});

	test("view field alongside an owned string field", async () => {
		await build_and_check_output(
			`
struct Mixed {
	var view string borrowed
	var string owned
}
var string doc = "source"
if doc.length == 6 {
	var List<Mixed> items = List<Mixed>()
	items.push(Mixed(doc.slice(0, 3), doc.to_string()))
	var int i = 0
	while i < items.length {
		var Mixed m = items.at(i)
		Console.write(m.borrowed.to_string())
		Console.write(m.owned.to_string())
		i = i + 1
	}
}
`,
			"view_field_mixed",
			"sousource",
		);
	});

	test("view int field over an int array", async () => {
		await build_and_check_output(
			`
struct Window {
	var view int values
}
var int[] nums = [10, 20, 30, 40]
if nums.length == 4 {
	var Window w = Window(nums.slice(1, 3))
	Console.write("\\{w.values.length}")
	Console.write("\\{w.values.at(0)}")
}
`,
			"view_field_int",
			"220",
		);
	});
});

// Check-only tests for the borrow semantics (backend-independent): an
// instance whose view fields borrow from the enclosing scope may not escape
// (return / outer-scope assignment), and mutating the source invalidates the
// fields until they are re-pointed. `ref` fields stay rejected.
function errors(src: string) {
	return parse(src, lib).errors.map((e) => `${e.message}`);
}

describe("view struct field borrow semantics", () => {
	test("declaring the TODO's Line struct is accepted", () => {
		expect(
			errors(`
import System
pub struct Line {
	var view string text = ""
	var start = 0
	var len = 0
}
pub func main = () { Console.write("x") }`),
		).toEqual([]);
	});

	test("returning a struct whose view field borrows a local is rejected", () => {
		expect(
			errors(`
import System
struct Line {
	var view string text
}
func make_line = (out Line) {
	var string doc = "hello"
	return Line(doc.slice(0, 2))
}
pub func main = () { Console.write("x") }`).some((m) => m.includes("'view' field")),
		).toBe(true);
	});

	test("returning a pre-built struct with a local borrow is rejected", () => {
		expect(
			errors(`
import System
struct Line {
	var view string text
}
func make_line = (out Line) {
	var string doc = "hello"
	var Line l = Line(doc.slice(0, 2))
	return l
}
pub func main = () { Console.write("x") }`).some((m) => m.includes("'view' field")),
		).toBe(true);
	});

	test("returning a struct whose view fields root at self is allowed", () => {
		// The re-rooting convention: a method may return a struct whose view
		// fields borrow from `self` — the caller re-roots the borrow at the
		// call-site receiver (same rule that lets slice methods return views).
		expect(
			errors(`
import System
struct Holder {
	var view string s
}
struct Token {
	var view string src

	pub func holder = (self, out Holder) {
		return Holder(self.src)
	}
}
pub func main = () {
	var string doc = "hello"
	if doc.length == 5 {
		var Token t = Token(doc.slice(1, 3))
		Console.write(t.holder().s.to_string())
	}
}`).filter((m) => m.includes("'view' field")),
		).toEqual([]);
	});

	test("reading a view field after reassigning its source is rejected", () => {
		expect(
			errors(`
import System
struct L2 {
	var view string text
}
pub func main = (int n) {
	var string doc = "hello"
	var L2 l = L2(doc.slice(0, 2))
	if n > 0 {
		doc = "other"
		Console.write(l.text.to_string())
	}
	Console.write("x")
}`).some((m) => m.includes("invalidated")),
		).toBe(true);
	});

	test("re-pointing the field after source mutation is accepted", () => {
		expect(
			errors(`
import System
struct L2 {
	var view string text
}
pub func main = (int n) {
	var string doc = "hello"
	var L2 l = L2(doc.slice(0, 2))
	if n > 0 {
		doc = "other"
		l.text = doc.slice(0, 3)
		Console.write(l.text.to_string())
	}
	Console.write("x")
}`).some((m) => m.includes("invalidated")),
		).toBe(false);
	});

	test("escaping a view-carrying struct to an outer scope is rejected", () => {
		expect(
			errors(`
import System
struct L2 {
	var view string text
}
pub func main = (int n) {
	var L2 outer
	var string doc = "hello"
	if n > 0 {
		outer = L2(doc.slice(0, 2))
	}
	Console.write(outer.text.to_string())
}`).length,
		).toBeGreaterThan(0);
	});

	test("'ref' fields are still rejected", () => {
		expect(
			errors(`
import System
struct R {
	var ref string t
}
pub func main = () { Console.write("x") }`).some((m) => m.includes("cannot be 'ref'")),
		).toBe(true);
	});
});
