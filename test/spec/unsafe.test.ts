import { expect, describe, test } from "vite-plus/test";

import parse from "../../src/parse.ts";
import { compile_main, core } from "./_helpers.ts";

// SPEC.md "Unsafe Code" — every fenced example in the section.

describe("spec: unsafe code", () => {
	test("user unsafe block is rejected (lockdown)", () => {
		const errors = compile_main(`
unsafe {
	var p = 0
}
`);
		expect(
			errors.some((e) => e.message.includes("'unsafe' is reserved for the System library")),
		).toBe(true);
	});

	test("library unsafe body with ptr indexing compiles clean", () => {
		// The spec's ptr-indexing example is shaped like the core String.at
		// primitive (a `func` with an `unsafe { ... }` body); parse+check a
		// program that pulls the library and proves no errors.
		const source = `import System

pub func main = () {
	var string s = "abc"
	Console.write("{s.at(1)}")
}
`;
		const parsed = parse(source, core);
		expect(parsed.errors).toEqual([]);
	});
});
