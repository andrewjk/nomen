import { expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

/**
 * C output ordering: top-level (program-scope AND library-scope) global
 * definitions must precede every function definition that reads them. C
 * requires the definition to be visible before the use; when the definitions
 * trailed the functions, uses relied on the `extern` header declarations (or
 * on compiler leniency — the same bytes have been observed flipping between
 * clean compile and hard `use of undeclared identifier` errors across runs of
 * the same clang). The aarch64 backend already gets this ordering via its
 * data section, so only the C text is asserted here; build_and_check_output
 * covers both backends behaviorally.
 */
function compile_c(source: string): { code: string; headers: string } {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "c" });
	return { code: result.code, headers: result.headers };
}

test("top-level const definition precedes the functions that read it", () => {
	const { code } = compile_c(`
import System
const solar_mass = 39.47841760435743447534

func half = (float v, out float) {
	return v / solar_mass
}

pub func main = (Init init) {
	Console.write("\\{half(10.0)}")
}
`);
	const definition = code.indexOf("double solar_mass = ");
	expect(definition).toBeGreaterThan(-1);
	// First use sits inside the reader function body, after the definition.
	const use = code.indexOf("/ solar_mass");
	expect(use).toBeGreaterThan(definition);
});

test("top-level const declared after its reader in source still precedes it in the C output", () => {
	// Simulates the library-appended shape: the merged source places library
	// globals after the user's functions, so source order alone would define
	// them after their readers. The hoist must not depend on source order.
	const { code } = compile_c(`
import System
func scale = (int v, out int) {
	return v * factor
}

const factor = 3

pub func main = (Init init) {
	Console.write("\\{scale(14)}")
}
`);
	const definition = code.indexOf("long factor = ");
	expect(definition).toBeGreaterThan(-1);
	const use = code.indexOf("* factor");
	expect(use).toBeGreaterThan(definition);
});

test("top-level var definition precedes the functions that read it", () => {
	const { code } = compile_c(`
import System
var counter = 0

func bump = (out int) {
	counter = counter + 1
	return counter
}

pub func main = (Init init) {
	Console.write("\\{bump()}")
	Console.write("\\{bump()}")
}
`);
	const definition = code.indexOf("long counter = ");
	expect(definition).toBeGreaterThan(-1);
	const use = code.indexOf("counter + 1");
	expect(use).toBeGreaterThan(definition);
});

test("global const read by a function produces the same output on both backends", async () => {
	// The const is declared AFTER its reader in source (the merged-source
	// shape every library const lands in) — the exact shape that emitted the
	// definition after the reading functions before the hoist.
	await build_and_check_output(
		`
import System

func triple = (int v, out int) {
	return v * step
}

const step = 3

pub func main = (Init init) {
	Console.write("\\{triple(12)}")
}
`,
		"c_const_ordering_global",
		"36",
		true,
	);
});
