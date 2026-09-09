import path from "node:path";

import { expect, describe, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";

// Free library functions (`pub func` at library file scope) must resolve
// from any user program, independent of which types the program happens to
// reference. The library resolver indexes free functions by name; before
// that, `parse_int("41")` resolved only when something else pulled in
// Init.nm — e.g. a `main = (Init init)` signature — so a parameterless
// `main` failed with "Function not found: parse_int".

const core = get_library(path.resolve(import.meta.dirname, "../core"));

describe("free library function resolution", () => {
	test("callable from a parameterless main", () => {
		const input = `import System
pub func main = () {
	const int n = parse_int("41")
	Console.write("\\{n}")
}
`;
		expect(parse(input, core).errors).toEqual([]);
	});

	test("callable with no other library reference in the program", () => {
		// No struct, trait, or type token from the declaring file appears —
		// only the function name itself.
		const input = `import System
pub func main = () {
	Console.write("\\{parse_int(init_dummy())}")
}
`;
		const errors = parse(input, core).errors;
		// init_dummy is unknown, but parse_int itself must resolve.
		expect(errors.some((e) => e.message.includes("parse_int"))).toBe(false);
	});

	test("user declaration shadows the library function without duplicates", () => {
		const input = `import System
func parse_int = (string s, out int) {
	return 7
}
pub func main = () {
	Console.write("\\{parse_int("x")}")
}
`;
		expect(parse(input, core).errors).toEqual([]);
	});
});
