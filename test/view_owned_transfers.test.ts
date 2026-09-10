import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";
import build_and_check_output from "./build_and_check_output.ts";

const core = path.resolve(import.meta.dirname, "../core");

// A `view string` stored into an owned `string` slot materializes a
// length-bounded owned copy (value semantics) — never an alias of the
// source buffer, on either backend. Covers bare-variable, call-result,
// declaration, and `move` return shapes; assertions use length-aware `==`
// (Console.write is NUL-terminated and would over-read a mid-buffer view).
test("view to owned transfers materialize", async () => {
	const input = `
pub func moveme = (out string) {
	var string h = "ab" + "cd"
	if h.length >= 1 {
		view v = h.slice(0, 1)
		return move v
	}
	return ""
}

var string doc = "hello world"
view v = doc.slice(0, 5)
var string s = "........"
s = v
if s == "hello" {
	Console.write("A")
} else {
	Console.write("a")
}
if s.length == 5 {
	Console.write("B")
} else {
	Console.write("b")
}
var string t = v
if t == "hello" {
	Console.write("C")
} else {
	Console.write("c")
}
var string u = "........"
u = doc.slice(6, 11)
if u == "world" {
	Console.write("D")
} else {
	Console.write("d")
}
if moveme() == "a" {
	Console.write("E")
} else {
	Console.write("e")
}
var string w = "........"
w = move v
if w == "hello" {
	Console.write("F")
} else {
	Console.write("f")
}
`;
	await build_and_check_output(input, "view_owned_transfers", "ABCDEF");
});

// A plain call with `view` parameters whose declared result is an owned
// `string` does not propagate the arguments' borrows: the result owns its
// storage (a `to_string` materialization), so returning it is sound.
test("owned result of view-param call is not tainted", async () => {
	const input = `
pub func snip = (view string text, int start, int end, out string) {
	if start < 0 || start > text.length || end < start || end > text.length {
		return ""
	}
	const string r = text.slice(start, end).to_string()
	return r
}
pub func wrap = (string text, int start, int end, out string) {
	return snip(text, start, end)
}

var string doc = "hello world"
Console.write(wrap(doc, 0, 5))
`;
	await build_and_check_output(input, "view_call_owned_result", "hello");
});

describe("view taint soundness", () => {
	test("struct result with view fields is still tainted", () => {
		const input = `
import System
pub struct VLine {
	var view string text
}
pub func make = (string doc, out VLine) {
	view v = doc.slice(0, 1)
	return VLine(v)
}
pub func main = (Init init) {
	Console.write("ok")
}
`;
		const parsed = parse(input, get_library(core));
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("borrow from this scope"))).toBe(true);
	});
});
