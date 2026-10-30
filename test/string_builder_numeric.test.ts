import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// PERF_PLAN item 10 — numeric appends + single-pass interpolation.
//
// `StringBuilder.append` is an overload set (int / float / char / view
// string): numeric appends format straight into the buffer (no intermediate
// string, no snprintf for ints), and the `_string_interpolate_N` helper is a
// single exact-size copy pass (no snprintf, no sizing scan) whose length is
// known from the fat-string arguments alone.

function build_aarch64(input: string): string {
	const parsed = parse_raw(`import System\n${input}`);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code ?? "";
}

describe("StringBuilder numeric appends", () => {
	test("append overloads: int, negative, char, float, string", async () => {
		await build_and_check_output(
			`
var StringBuilder sb = StringBuilder()
sb.append(0)
sb.append("|")
sb.append(42)
sb.append("|")
sb.append(-9001)
sb.append("|")
sb.append('z')
sb.append("|")
sb.append(1.5)
sb.append("|")
sb.append("tail")
Console.write(sb.to_string())`,
			"sb_append_overloads",
			"0|42|-9001|z|1.500000|tail",
		);
	});

	test("append matches to_string text for the int extremes", async () => {
		await build_and_check_output(
			`
var StringBuilder sb = StringBuilder()
sb.append(9223372036854775807)
sb.append("|")
sb.append(-9223372036854775808)
sb.append("|")
sb.append(-1)
Console.write(sb.to_string())`,
			"sb_append_int_extremes",
			"9223372036854775807|-9223372036854775808|-1",
		);
	});

	test("direct append_int / append_float primitives agree with append", async () => {
		await build_and_check_output(
			`
var StringBuilder a = StringBuilder()
a.append_int(12345)
a.append_float(-2.25)
var StringBuilder b = StringBuilder()
b.append(12345)
b.append(-2.25)
Console.write("\\{a.to_string() == b.to_string()}")`,
			"sb_append_primitives",
			"true",
		);
	});
});

describe("single-pass interpolation", () => {
	test("mixed numeric and string arguments", async () => {
		await build_and_check_output(
			`
var string s = "abc"
var int n = -123
Console.write("\\{s}:\\{n}:\\{s.length}:\\{1.25}")`,
			"interp_mixed",
			"abc:-123:3:1.250000",
		);
	});

	test("high arity (stack-passed argument pairs)", async () => {
		await build_and_check_output(
			`
Console.write("\\{1}-\\{2}-\\{3}-\\{4}-\\{5}-\\{6}-\\{7}-\\{8}-\\{9}-\\{10}")`,
			"interp_high_arity",
			"1-2-3-4-5-6-7-8-9-10",
		);
	});

	test("a literal '%' in the source text is copied verbatim", async () => {
		// The old snprintf-based helper consumed '%' as a format directive
		// (`"100%"` lost the sign, and `"%d"` read a garbage argument).
		await build_and_check_output(
			`
Console.write("100% of \\{21 + 21}")`,
			"interp_literal_percent",
			"100% of 42",
		);
	});

	test("empty rendered arguments", async () => {
		await build_and_check_output(
			`
var string empty = ""
Console.write("[\\{empty}]\\{""}")`,
			"interp_empty_args",
			"[]",
		);
	});
});

describe("single-pass lowering shape (aarch64)", () => {
	function function_asm(code: string, label: string): string {
		const start = code.indexOf(`\n${label}\n`);
		expect(start, `label ${label} not found`).toBeGreaterThanOrEqual(0);
		const body = code.slice(start + 1);
		const end = body.indexOf("\n.p2align");
		return end === -1 ? body : body.slice(0, end);
	}

	test("int.to_string and the interpolation helper avoid snprintf", () => {
		const code = build_aarch64(
			`
func show = (int n, out string) {
	return "\\{n}"
}
show(1)`,
		);
		// The int formatter is a hand-rolled digit loop; the interpolation
		// helper copies fat-string bytes. Neither may call snprintf.
		const int_to_string = function_asm(code, "int_to_string:");
		expect(int_to_string).not.toContain("bl _snprintf");
		const interp = function_asm(code, "_string_interpolate_1:");
		expect(interp).not.toContain("bl _snprintf");
		expect(interp).toContain("bl _malloc");
	});

	test("append_int splices without a call to the primitive", () => {
		const code = build_aarch64(
			`
var StringBuilder sb = StringBuilder()
sb.append_int(7)`,
		);
		// The raw body splices (labels renamed per site), so there is no
		// standalone `StringBuilder_append_int` call, and the append's own
		// body does not call snprintf (the library-wide float formatter
		// legitimately does).
		expect(code).not.toContain("bl StringBuilder_append_int");
		const start = code.indexOf("StringBuilder_append__int:");
		const rest = code.slice(start);
		const body = rest.slice(0, rest.indexOf("\n.p2align"));
		expect(body).not.toContain("bl _snprintf");
		expect(body).toMatch(/sub x12, x12, #1/);
	});
});
