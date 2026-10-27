import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";

// Regression (FOLLOWUP): `T_SIZE` was unresolved in unsafe-Nomen foreign-call
// ARGS. The monomorphizer's ValueNode substitution walked an if's CONDITION
// (that is what fold_substituted_constant_ifs dispatches on) but never its
// branch bodies, so a constant used inside a surviving arm —
// `calloc(count, T_SIZE)` under `if T_FAT` — kept the raw symbol into the
// emitted code, where the value emitter's unknown-value fallback spliced it
// in as a bogus global read (`adr x0, T_SIZE@PAGE`). Expression positions
// (`slot * T_SIZE`) folded fine, which is why the direct paths never caught
// it. The substitution now descends into branches; these pins hold both
// backends to the literal.

const tsize_lib = get_library(path.resolve(import.meta.dirname, "fixtures/tsize_lib"));

function compile(arch: "aarch64" | "c", element: "int" | "string"): string {
	const input = `import System
pub func main = () {
	var TSizeCallBox<${element}> b = TSizeCallBox<${element}>()
	b.alloc_direct(4)
	b.alloc_in_constant_if(4)
	b.wipe(4)
}
`;
	const parsed = parse(input, tsize_lib);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

test("T_SIZE never survives into emitted code, both backends, both arms", () => {
	for (const arch of ["aarch64", "c"] as const) {
		for (const element of ["int", "string"] as const) {
			const code = compile(arch, element);
			expect(code.includes("T_SIZE")).toBe(false);
		}
	}
});

test("aarch64 call args carry the substituted literal (int: 8, string: 16)", () => {
	// int element: the surviving `if T_FAT` arm is the else branch; its
	// calloc must load the size as an immediate, not a symbol.
	const int_code = compile("aarch64", "int");
	const int_fn = int_code.slice(
		int_code.indexOf("TSizeCallBox_int_alloc_in_constant_if:"),
		int_code.indexOf(".return_TSizeCallBox_int_alloc_in_constant_if:"),
	);
	expect(int_fn).toContain("mov x1, #8");
	expect(int_fn).toContain("bl foreign_calloc");
	expect(int_fn).not.toContain("T_SIZE");

	// string element: T_FAT is true, so the THEN arm survives (calloc runs
	// for a string element) and the size is the fat 16.
	const string_code = compile("aarch64", "string");
	const string_fn = string_code.slice(
		string_code.indexOf("TSizeCallBox_string_alloc_in_constant_if:"),
		string_code.indexOf(".return_TSizeCallBox_string_alloc_in_constant_if:"),
	);
	expect(string_fn).toContain("mov x1, #16");
	expect(string_fn).toContain("bl foreign_calloc");
	expect(string_fn).not.toContain("T_SIZE");
});

test("C backend call args carry the substituted literal too", () => {
	const code = compile("c", "int");
	const fn = code.slice(
		code.indexOf("void TSizeCallBox_int_alloc_in_constant_if("),
		code.indexOf("void TSizeCallBox_int_wipe("),
	);
	expect(fn).toContain("foreign_calloc(count, 8L)");
	expect(fn).not.toContain("T_SIZE");
	expect(fn).not.toContain("T_FAT");
});

// The fixture file must not drift from what these pins rely on.
test("fixture declares the shapes the pins compile", () => {
	const source = fs.readFileSync(
		path.resolve(import.meta.dirname, "fixtures/tsize_lib/TSizeCallBox.nm"),
		"utf8",
	);
	expect(source).toContain("calloc(count, T_SIZE)");
	expect(source).toContain("if T_FAT");
});
