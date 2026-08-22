import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

// Regression tests for the aarch64 view-materialization miscompile
// (NOMEN_TODO 2026-08-22, since fixed):
//  (a) a named `view string` local returned as owned via `.to_string()`:
//      the shared string-return analysis mis-classified the materialization
//      as a borrow, so the function's literal `return ""` branch skipped the
//      boundary strdup while the caller freed every result — SIGABRT at
//      scope-destroy (freeing rodata);
//  (b) an inline `text.slice(...).to_string()` chain resolved to the
//      `string_to_string` identity (`mov x0, x19`), handing consumers the raw
//      slice pointer — not NUL-terminated at len — so strlen-based readers
//      ran past the slice and produced wrong contents.
// Both shapes run on the C and aarch64 backends; a non-zero exit (SIGABRT)
// or a LEAK report fails the test.

function errors(src: string) {
	return parse(src, lib).errors.map((e) => `${e.message}`);
}

describe("view materialization (runtime, both backends)", () => {
	test("named view returned as owned alongside a literal branch", async () => {
		const input = `
import System

func extract = (string text, int start: start >= 0 && start <= text.length, int end: end >= start && end <= text.length, out string) {
	if end == start {
		return ""
	}
	const view string v = text.slice(start, end)
	return v.to_string()
}

pub func main = () {
	var string text = "alpha bravo charlie delta"
	const string a = extract(text, 0, 5)
	const string empty = extract(text, 3, 3)
	const string b = extract(text, 6, 11)
	Console.write("[\\{a}][\\{empty}][\\{b}]")
}
`;
		expect(errors(input)).toEqual([]);
		await build_and_check_output(input, "view_mat_owned_return", "[alpha][][bravo]", true);
	});

	test("inline slice to_string chain in a loop", async () => {
		const input = `
import System

pub func main = () {
	var string text = "alpha bravo charlie delta"
	var int n = 0
	while n < 4 {
		if n == 0 {
			var string part = text.slice(0, 5).to_string()
			Console.write("[\\{part}]")
		}
		if n == 1 {
			var string part = text.slice(6, 11).to_string()
			Console.write("[\\{part}]")
		}
		if n == 2 {
			var string part = text.slice(12, 19).to_string()
			Console.write("[\\{part}]")
		}
		if n == 3 {
			var string part = text.slice(20, 25).to_string()
			Console.write("[\\{part}]")
		}
		n = n + 1
	}
}
`;
		expect(errors(input)).toEqual([]);
		await build_and_check_output(
			input,
			"view_mat_inline_loop",
			"[alpha][bravo][charlie][delta]",
			true,
		);
	});

	test("at on an inline slice", async () => {
		const input = `
import System

pub func main = () {
	var string text = "alpha"
	var char c = text.slice(1, 4).at(0)
	Console.write(c.to_string())
}
`;
		expect(errors(input)).toEqual([]);
		await build_and_check_output(input, "view_mat_inline_at", "l", true);
	});

	test("materialized slices as concat operands", async () => {
		const input = `
import System

pub func main = () {
	var string text = "alpha bravo"
	var string joined = text.slice(0, 5).to_string() + "-" + text.slice(6, 11).to_string()
	Console.write("\\{joined}")
}
`;
		expect(errors(input)).toEqual([]);
		await build_and_check_output(input, "view_mat_concat", "alpha-bravo", true);
	});

	test("view param materialized and returned", async () => {
		const input = `
import System

func materialize = (view string v, out string) {
	return v.to_string()
}

pub func main = () {
	var string text = "charlie"
	const string s = materialize(text.slice(0, 7))
	Console.write("[\\{s}]")
}
`;
		expect(errors(input)).toEqual([]);
		await build_and_check_output(input, "view_mat_param", "[charlie]", true);
	});
});
