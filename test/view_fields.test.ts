import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

// `view T` struct fields — non-mv (ptr, len) slices stored inside struct
// instances. The field is a plain 16-byte pair: byte-copying a struct copies
// the borrow (sound), and nothing is freed on destroy (the field owns
// nothing). A struct with `view` fields is a SCOPE-LOCAL bundle: its escape
// routes are closed structurally — it cannot be passed as an argument
// (container stores included), cannot be returned (self-rooted included),
// and cannot be assigned to an outer scope. Mutating a borrow source
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

	test("pushing a view-carrying struct into a container is rejected", () => {
		// The container outlives the borrow source; struct stores are call
		// boundaries, and view-carrying structs cannot cross one.
		expect(
			errors(`
import System
${LINE}
pub func main = () {
	var string doc = "aa bb"
	var List<Line> lines = List<Line>()
	lines.push(Line(doc.slice(0, 2)))
	Console.write("x")
}`).some((m) => m.includes("scope-local")),
		).toBe(true);
	});

	test("view field alongside an owned string field", async () => {
		await build_and_check_output(
			`
mv struct Mixed {
	var view string borrowed
	var string owned
}
var string doc = "source"
if doc.length == 6 {
	var Mixed m = Mixed(doc.slice(0, 3), doc.to_string())
	Console.write(m.borrowed.to_string())
	Console.write(m.owned.to_string())
}
`,
			"view_field_mixed",
			"sousource",
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

// Check-only tests for the borrow semantics (backend-independent): a struct
// with `view` fields is a scope-local bundle — it may not escape via return,
// outer-scope assignment, OR a call argument (container stores included).
// Mutating the source invalidates the fields until they are re-pointed.
// `ref` fields stay rejected.
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

	test("returning a view-carrying struct is rejected, self-rooted included", () => {
		// The re-rooting convention cannot help a whole struct: the caller's
		// binding cannot be pinned to the bundle's sources across the call
		// boundary, so a struct with `view` fields is scope-local — return
		// the fields (the views) instead, which re-root at the receiver.
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
}`).some((m) => m.includes("scope-local")),
		).toBe(true);
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

	test("passing a view-carrying struct to a function is rejected", () => {
		expect(
			errors(`
import System
struct Line {
	var view string text
}
func render = (Line l) {
	Console.write(l.text.to_string())
}
pub func main = () {
	var string doc = "hello"
	var Line l = Line(doc.slice(0, 2))
	render(l)
}`).some((m) => m.includes("scope-local")),
		).toBe(true);
	});

	test("enum case payloads cannot carry view borrows", () => {
		// A payload is stored inside the tagged union — the enum wrapper
		// would ferry the scope-local bundle past every boundary ban.
		expect(
			errors(`
import System
struct Line {
	var view string text
}
enum Holder {
	case line(Line value)
	case empty
}
pub func main = () {
	var string doc = "hello"
	var Line l = Line(doc.slice(0, 2))
	var Holder h = Holder.line(l)
	Console.write("x")
}`).some((m) => m.includes("scope-local")),
		).toBe(true);

		expect(
			errors(`
import System
struct Line {
	var view string text
}
pub func main = () {
	var string doc = "hello"
	var [.carries(Line)] h = .carries(Line(doc.slice(0, 2)))
	Console.write("x")
}`).some((m) => m.includes("scope-local")),
		).toBe(true);
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
