import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("string stdlib query methods", () => {
	test("index_of and index_of_from", async () => {
		const input = `
var int a = "hello".index_of("l")
var int b = "hello".index_of("z")
var int c = "hello".index_of("")
var int d = "hello".index_of_from("l", 3)
var int e = "hello".index_of_from("l", 4)
var int f = "hello".index_of_from("h", -2)
var int g = "hello".index_of_from("", 9)
var int h = "hello".index_of_from("hello", 1)
Console.write("\\{a} \\{b} \\{c} \\{d}\\n")
Console.write("\\{e} \\{f} \\{g} \\{h}\\n")
`;
		await build_and_check_output(input, "string_index_of", "2 -1 0 3\n-1 0 5 -1\n");
	});

	test("contains, starts_with, ends_with", async () => {
		const input = `
var bool a = "hello".contains("ell")
var bool b = "hello".contains("z")
var bool c = "".contains("")
var bool d = "hello".starts_with("he")
var bool e = "hello".starts_with("hello")
var bool f = "hello".starts_with("hellox")
var bool g = "hello".ends_with("lo")
var bool h = "hello".ends_with("hello")
var bool i = "hello".ends_with("xhello")
var bool j = "".starts_with("")
Console.write("\\{a} \\{b} \\{c} \\{d} \\{e}\\n")
Console.write("\\{f} \\{g} \\{h} \\{i} \\{j}\\n")
`;
		await build_and_check_output(
			input,
			"string_prefix_suffix",
			"true false true true true\nfalse true true false true\n",
		);
	});

	test("char_code_at is bounds-constrained", async () => {
		// `char_code_at` carries `at`'s constraint: out-of-bounds reads are
		// unrepresentable (literal indexes are compile errors; dynamic ones
		// must be proven by flow facts). In-bounds reads return the byte.
		const input = `
var int a = "Abc".char_code_at(0)
var int b = "Abc".char_code_at(2)
var int e = "Abc".char_code_at(1)
Console.write("\\{a} \\{b} \\{e}\\n")
`;
		await build_and_check_output(input, "string_char_code_at", "65 99 98\n");
	});

	test("char_code_at_or falls back, char_code_at_or_panic reads", async () => {
		const input = `
var int a = "Abc".char_code_at_or(0, -1)
var int b = "Abc".char_code_at_or(3, -1)
var int c = "Abc".char_code_at_or(-2, -1)
var int d = "Abc".char_code_at_or_panic(1)
Console.write("\\{a} \\{b} \\{c} \\{d}\\n")
`;
		await build_and_check_output(input, "string_char_code_at_or", "65 -1 -1 98\n");
	});

	test("substring clamps its bounds", async () => {
		const input = `
Console.write("[" + "hello".substring(1, 3) + "]\\n")
Console.write("[" + "hello".substring(0, 99) + "]\\n")
Console.write("[" + "hello".substring(99, 100) + "]\\n")
Console.write("[" + "hello".substring(-5, 2) + "]\\n")
Console.write("[" + "hello".substring(3, 1) + "]\\n")
Console.write("[" + "hello".substring(2, 2) + "]\\n")
`;
		await build_and_check_output(input, "string_substring", "[el]\n[hello]\n[]\n[he]\n[]\n[]\n");
	});

	test("trim, trim_start, trim_end", async () => {
		const input = `
Console.write("[" + "  hi  ".trim() + "]\\n")
Console.write("[" + "\\t\\n hi \\n\\t".trim() + "]\\n")
Console.write("[" + "   ".trim() + "]\\n")
Console.write("[" + "hi".trim() + "]\\n")
Console.write("[" + "  hi".trim_start() + "]\\n")
Console.write("[" + "hi  ".trim_end() + "]\\n")
Console.write("[" + "  hi  ".trim_start() + "]\\n")
Console.write("[" + "  hi  ".trim_end() + "]\\n")
`;
		await build_and_check_output(
			input,
			"string_trim",
			"[hi]\n[hi]\n[]\n[hi]\n[hi]\n[hi]\n[hi  ]\n[  hi]\n",
		);
	});

	test("to_lowercase and to_uppercase are ASCII-only", async () => {
		const input = `
Console.write("MiXeD 123!".to_lowercase() + "\\n")
Console.write("MiXeD 123!".to_uppercase() + "\\n")
Console.write("caf\\xC3\\xA9".to_uppercase() + "\\n")
Console.write("caf\\xC3\\xA9".to_lowercase() + "\\n")
`;
		await build_and_check_output(input, "string_case_map", "mixed 123!\nMIXED 123!\nCAFé\ncafé\n");
	});
});
