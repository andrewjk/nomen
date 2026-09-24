import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

// StringBuilder member visibility. Struct members DEFAULT to `pub`, which
// once made `ensure`/`append_string` (implementation details) callable from
// user modules and left `to_string`/`take_since` pub only by accident of
// the default. The surface is now explicit: `to_string`/`take_since` are
// `pub` (the read-back contract), `ensure`/`append_string` are `internal`
// (the library's Json/Regex sit on the trusted side of the boundary; user
// code appends with `append_char`/`append_string_view`).
// Parsed WITHOUT allow_internal: these checks are about the untrusted
// user-module side of the System library boundary.

function check_user_program(source: string) {
	const parsed = parse(source, system, undefined, {});
	return parsed.errors;
}

describe("StringBuilder member visibility", () => {
	test("internal append_string is rejected for user modules", () => {
		const errors = check_user_program(`
import System

pub func main = () {
	var StringBuilder sb = StringBuilder()
	sb.append_string("hello")
	Console.write_line(sb.to_string())
}
`);
		expect(errors.map((e) => e.message)).toContain("Can't access internal function: append_string");
	});

	test("internal ensure is rejected for user modules", () => {
		const errors = check_user_program(`
import System

pub func main = () {
	var StringBuilder sb = StringBuilder()
	sb.ensure(64)
}
`);
		expect(errors.map((e) => e.message)).toContain("Can't access internal function: ensure");
	});

	test("pub read-backs still work from user modules", () => {
		const errors = check_user_program(`
import System

pub func main = () {
	var StringBuilder sb = StringBuilder()
	sb.seed("hello")
	Console.write_line(sb.to_string())
	var string tail = sb.take_since(3)
	Console.write_line(tail)
}
`);
		expect(errors).toEqual([]);
	});
});
