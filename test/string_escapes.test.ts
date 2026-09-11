import { expect, describe, test } from "vite-plus/test";

import tokenize from "../src/tokenize";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// The tokenizer consumes escape pairs left-to-right, so a literal backslash
// (`\\`) can sit next to braces, brackets, and quotes without mis-tokenizing:
// `\\{` is NOT an interpolation start and `\\"` does NOT escape the closing
// quote. Char literals decode escape pairs the same way (`'\\'`, `'\n'`).
// String.raw is used throughout so expected values need no extra escaping.

describe("string and char escape pairing", () => {
	test("escaped backslash before a brace is not interpolation", () => {
		// nomen source: "\\{code}" (one escaped backslash, then {code})
		const toks = tokenize(String.raw`"\\{code}"`);
		expect(toks.map((t) => t.value)).toEqual([String.raw`"\\{code}"`]);
		expect(toks.some((t) => t.value === String.raw`\{`)).toBe(false);
	});

	test("escaped backslash before the closing quote ends the string", () => {
		// nomen source: "a\\"
		const toks = tokenize(String.raw`"a\\"`);
		expect(toks.map((t) => t.value)).toEqual([String.raw`"a\\"`]);
	});

	test("escaped quote before an interpolation", () => {
		// nomen source: " start=\"\{n}\"" — the catastrophic case: a string
		// fragment, one interpolation, and a closing fragment.
		const toks = tokenize(String.raw`" start=\"\{n}\""`);
		const values = toks.map((t) => t.value);
		expect(values.filter((v) => v === String.raw`\{`).length).toBe(1);
		expect(values[0].startsWith(String.raw`"`)).toBe(true);
		expect(values[values.length - 1].endsWith(String.raw`"`)).toBe(true);
	});

	test("odd backslash runs interpolate; even runs do not", () => {
		// odd: "\\\{y}" interpolates; even: "\\\\{z}" is one literal token.
		const odd = tokenize(String.raw`"\\\{y}"`);
		expect(odd.some((t) => t.value === String.raw`\{`)).toBe(true);
		const even = tokenize(String.raw`"\\\\{z}"`);
		expect(even.length).toBe(1);
		expect(even.some((t) => t.value === String.raw`\{`)).toBe(false);
	});

	test("char literals consume escape pairs", () => {
		expect(tokenize(String.raw`'\\'`).map((t) => t.value)).toEqual([String.raw`'\\'`]);
		expect(tokenize(String.raw`'\n'`).map((t) => t.value)).toEqual([String.raw`'\n'`]);
		expect(tokenize(String.raw`'h'`).map((t) => t.value)).toEqual([String.raw`'h'`]);
	});

	test("end-to-end: escape runs decode identically on both backends", async () => {
		const input = String.raw`
import System

pub func main = (Init init) {
	var string a = "\\{code}"
	var string b = "a\\"
	var string c = "\\[x]"
	var string e = "a\\nb"
	var string f = "line1\nline2"
	var char nl = '\n'
	var char bs = '\\'
	Console.write("a=[" + a + "]\n")
	Console.write("b=[" + b + "]\n")
	Console.write("c=[" + c + "]\n")
	Console.write("e=[" + e + "]\n")
	Console.write("f=[" + f + "]\n")
	Console.write("nl=\{nl as int} bs=\{bs as int}\n")
	Console.write("done\n")
}
`.trimStart();
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"string_escape_runs",
			"a=[\\{code}]\nb=[a\\]\nc=[\\[x]]\ne=[a\\nb]\nf=[line1\nline2]\nnl=10 bs=92\ndone\n",
			true,
		);
	});
});
