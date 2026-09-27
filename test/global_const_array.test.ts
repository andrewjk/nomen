import { expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// A module-level `const string[] = [...]` used to emit INVALID code on both
// backends: the C initializer wrapped every element in `nomen_str_dup(...)` —
// a function call, which a static initializer cannot contain — and the
// aarch64 data rows doubled the `.quad` directive (and lacked the length
// prefix word the Array_* accessors read from `[symbol - 8]`).
//
// C now lowers file-scope string-array literals to constant `{ ptr, len }`
// brace pairs (globals own nothing and have no scope exit to free them), and
// aarch64 lays out the length-prefixed element storage statically while
// main's prologue stores the rodata label addresses at runtime (Mach-O arm64
// forbids pointer relocations in data sections). Primitive-element globals
// (`const int[]`) gain the same length prefix.
test("global const string[] and int[] literals", async () => {
	const input = `
import System

pub const string[] WORDS = ["alpha", "beta", "gamma"]
pub const int[] NUMS = [10, 20, 30]

pub func main = (Init init) {
	Console.write_line(WORDS.at_or_panic(0))
	Console.write_line(WORDS.at_or_panic(2))
	Console.write_line("\\{WORDS.length} \\{WORDS.at_or_panic(1).length}")
	Console.write_line("\\{NUMS.at_or_panic(2)} \\{NUMS.length}")
}
`;
	await build_and_check_output(
		input,
		"global_const_array_literals",
		"alpha\ngamma\n3 4\n30 3\n",
		true,
	);
});

// The C emission must be a PURE static initializer: no `nomen_str_dup` calls
// anywhere in the global's definition (they are what made the file invalid C).
test("C global string array initializer is static", async () => {
	const input = `
import System

pub const string[] WORDS = ["alpha", "beta"]

pub func main = (Init init) {
	Console.write_line(WORDS.at_or_panic(1))
}
`;
	const parsed = parse_raw(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "c" });
	expect(result.errors ?? []).toEqual([]);
	const decl = result.code.match(/nomen_string WORDS\[[^\n]*/)?.[0] ?? "";
	expect(decl).not.toBe("");
	expect(decl).not.toContain("nomen_str_dup");
	expect(decl).toContain('{ "alpha", 5 }');
	expect(decl).toContain('{ "beta", 4 }');
});
