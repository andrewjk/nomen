import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("char classification helpers", () => {
	test("is_digit and is_alpha are ASCII-only", async () => {
		const input = `
var char zero = '0'
var char nine = '9'
var char slash = '/'
var char colon = ':'
var char upper = 'Z'
var char lower = 'z'
var char at = '@'
var char bracket = '['
Console.write("\\{zero.is_digit()} \\{nine.is_digit()} \\{slash.is_digit()} \\{colon.is_digit()}\\n")
Console.write("\\{upper.is_alpha()} \\{lower.is_alpha()} \\{at.is_alpha()} \\{bracket.is_alpha()}\\n")
Console.write("\\{upper.is_digit()} \\{slash.is_alpha()}\\n")
`;
		await build_and_check_output(
			input,
			"char_digit_alpha",
			"true true false false\ntrue true false false\nfalse false\n",
		);
	});

	test("is_ascii_space covers tab..CR and space", async () => {
		const input = `
var char space = ' '
var char tab = '\\t'
var char nl = '\\n'
var char cr = '\\r'
var char x = 'x'
Console.write("\\{space.is_ascii_space()} \\{tab.is_ascii_space()} \\{nl.is_ascii_space()} \\{cr.is_ascii_space()} \\{x.is_ascii_space()}\\n")
`;
		await build_and_check_output(input, "char_ascii_space", "true true true true false\n");
	});

	test("is_alphanumeric joins the two", async () => {
		const input = `
var char d = '7'
var char a = 'Q'
var char s = '-'
Console.write("\\{d.is_alphanumeric()} \\{a.is_alphanumeric()} \\{s.is_alphanumeric()}\\n")
`;
		await build_and_check_output(input, "char_alphanumeric", "true true false\n");
	});

	test("string trim uses the shared classifier", async () => {
		const input = `
Console.write("[" + "  hi  ".trim() + "]\\n")
Console.write("[" + "\\t\\n\\r hi \\013\\014".trim() + "]\\n")
`;
		await build_and_check_output(input, "char_trim_shared", "[hi]\n[hi]\n");
	});
});
