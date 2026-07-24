import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

// `view string` — a non-owning (ptr, len) slice returned by string.slice().
// It borrows from its source: it may not outlive the source's scope and is
// invalidated when the source is reassigned. These runtime tests run on both
// backends (C and aarch64).

describe("view string slice (runtime, both backends)", () => {
	test("slice length", async () => {
		await build_and_check_output(
			`
var string s = "hello world"
if s.length == 11 {
	var view string v = s.slice(0, 5)
	Console.write("\\{v.length}")
}`,
			"view_slice_length",
			"5",
		);
	});

	test("slice to_string materializes an owned copy", async () => {
		await build_and_check_output(
			`
var string s = "hello world"
if s.length == 11 {
	var view string v = s.slice(6, 11)
	Console.write(v.to_string())
}`,
			"view_slice_to_string",
			"world",
		);
	});

	test("slice at reads a char", async () => {
		await build_and_check_output(
			`
var string s = "hello"
if s.length == 5 {
	var view string v = s.slice(0, 5)
	Console.write(v.at(1).to_string())
}`,
			"view_slice_at",
			"e",
		);
	});
});

// Check-only tests for the borrow semantics (backend-independent): a view may
// not be returned, may not escape to an outer scope, and is invalidated when
// its source is reassigned.
function errors(src: string) {
	return parse(src, lib).errors.map((e) => `${e.message}`);
}

describe("view string borrow semantics", () => {
	test("slice + length typecheck", () => {
		expect(
			errors(`
import System
pub func main = () {
	var string s = "hello"
	if s.length == 5 {
		var view string v = s.slice(0, 3)
		Console.write("\\{v.length}")
	}
}`),
		).toEqual([]);
	});

	test("returning a view is rejected", () => {
		expect(
			errors(`
import System
func bad = (string s: s.length >= 3, out view string) {
	return s.slice(0, 3)
}
pub func main = () { Console.write("x") }`).some((m) => m.includes("borrowed reference")),
		).toBe(true);
	});

	test("escaping a view to an outer scope is rejected", () => {
		expect(
			errors(`
import System
pub func main = () {
	var view string outer
	var string s = "hello"
	if s.length == 5 {
		outer = s.slice(0, 3)
	}
	Console.write("\\{outer.length}")
}`).length,
		).toBeGreaterThan(0);
	});

	test("using a view after reassigning its source is rejected", () => {
		expect(
			errors(`
import System
pub func main = () {
	var string s = "hello"
	if s.length == 5 {
		var view string v = s.slice(0, 3)
		s = "world"
		Console.write("\\{v.length}")
	}
}`).some((m) => m.includes("invalidat")),
		).toBe(true);
	});
});
