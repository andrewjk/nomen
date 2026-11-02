import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// PERF_PLAN items 10/8 remainder — writer-form interpolation lowering: a
// `\{expr}` whose expression is a numeric scalar no longer lowers through
// `<expr>.to_string()` (one malloc per argument). The checker strips the wrap
// and suffixes the helper with per-argument kinds (`s` string, `i` signed
// int, `u` unsigned int, `f` float); the mixed helper renders each numeric
// argument into its own frame scratch — the append_int digit loop, ONE
// snprintf `%f` per float — and then walks every argument as a (ptr, len)
// pair, the all-string helper's copy walk unchanged.

const KINDS_PROGRAM = `
mv struct S {
	var int v = 0
}

var int i = 42
var int neg = -7
var int zero = 0
var int64 big = 9223372036854775807
var int64 big_neg = -9000000000000000000
var int64 wrapped_min = 0
var uint64 u = 18446744073709551615
var int8 small = -3
var int16 small16 = -300
var int32 small32 = -70000
var uint8 usmall = 250
var uint32 uwide = 3405705229
var float fv = 1.5
var float fneg = -2.25
var string name = "n"
var string empty = ""
var S st = S()
st.v = 5
wrapped_min = big + 1
Console.write("i=\\{i} neg=\\{neg} zero=\\{zero}\\n")
Console.write("big=\\{big} min=\\{big_neg} wrap=\\{wrapped_min}\\n")
Console.write("u=\\{u}\\n")
Console.write("small=\\{small} small16=\\{small16} small32=\\{small32}\\n")
Console.write("usmall=\\{usmall} uwide=\\{uwide}\\n")
Console.write("fv=\\{fv} fneg=\\{fneg}\\n")
Console.write("mix \\{name} \\{i} \\{fv}!\\n")
Console.write("empty[\\{empty}] \\{i}\\n")
Console.write("expr \\{i * 2} \\{small + 1} \\{fv * 2.0}\\n")
Console.write("pct 100% of \\{i}\\n")
Console.write("struct field \\{st.v}\\n")
Console.write("high \\{name} \\{i} \\{fv} \\{name} \\{neg} \\{fneg} \\{name} \\{st.v}\\n")
`;

describe("writer-form interpolation", () => {
	test("numeric arguments render exactly (both backends, audit on)", async () => {
		await build_and_check_output(
			KINDS_PROGRAM,
			"interp_writer_form",
			"i=42 neg=-7 zero=0\n" +
				"big=9223372036854775807 min=-9000000000000000000 wrap=-9223372036854775808\n" +
				"u=18446744073709551615\n" +
				"small=-3 small16=-300 small32=-70000\n" +
				"usmall=250 uwide=3405705229\n" +
				"fv=1.500000 fneg=-2.250000\n" +
				"mix n 42 1.500000!\n" +
				"empty[] 42\n" +
				"expr 84 -2 3.000000\n" +
				"pct 100% of 42\n" +
				"struct field 5\n" +
				"high n 42 1.500000 n -7 -2.250000 n 5\n",
		);
	});

	test("the call site passes numerics raw — no per-argument to_string", () => {
		const parsed = parse_with_imports(KINDS_PROGRAM);
		expect(parsed.errors).toEqual([]);
		const a64 = build(parsed.root, { arch: "aarch64", audit: false }).code;
		const c = build(parsed.root, { arch: "c", audit: false }).code;
		// Mixed helpers exist on both backends...
		expect(a64).toContain("_string_interpolate_1_i:");
		expect(a64).toContain("_string_interpolate_3_iii:");
		expect(a64).toContain("_string_interpolate_3_sif:");
		expect(a64).toContain("_string_interpolate_2_ff:");
		expect(a64).toContain("_string_interpolate_8_sifsifsi:");
		expect(c).toContain("_string_interpolate_3_iii(");
		expect(c).toContain("_string_interpolate_3_sif(");
		// ...and the numeric arguments no longer call a to_string conversion:
		// the pattern/numeric call has no `${int|uint|float*}*_to_string`
		// around an interpolation site.
		const call = c.match(/_string_interpolate_[0-9]+_i+\([^;]*/)?.[0] ?? "";
		expect(call).not.toContain("_to_string(");
		// The C helper takes the typed parameters (long long / double).
		expect(c).toContain(
			"_string_interpolate_3_iif(nomen_string pattern, long long arg1, long long arg2, double arg3)",
		);
	});

	test("all-string interpolations keep the unsuffixed helper", () => {
		const parsed = parse_with_imports(`
var string a = "x"
var string b = "y"
Console.write("\\{a} and \\{b}\\n")
`);
		expect(parsed.errors).toEqual([]);
		const code = build(parsed.root, { arch: "aarch64", audit: false }).code;
		expect(code).toContain("_string_interpolate_2:");
		expect(code).not.toContain("_string_interpolate_2_ss:");
	});

	test("the writer-form shape carries no intermediate malloc", () => {
		const parsed = parse_with_imports(`
var int i = 7
var uint64 u = 8
var float f = 1.25
Console.write("\\{i} \\{u} \\{f}")
`);
		expect(parsed.errors).toEqual([]);
		const code = build(parsed.root, { arch: "aarch64", audit: false, optimize: true }).code;
		// The call site is conversion-free: no `<T>_to_string` call feeds the
		// helper (each would have been one malloc).
		const call_idx = code.indexOf("bl _string_interpolate_3_iuf");
		expect(call_idx).toBeGreaterThan(-1);
		const before_call = code.slice(Math.max(0, call_idx - 400), call_idx);
		expect(before_call).not.toMatch(/bl \w*_to_string\b/);
		// The digit renderer and the float snprintf live in the helper (one
		// result malloc, no per-argument allocation).
		expect(code).toContain(".Lsi_digit_string_interpolate_3_iuf_0");
		expect(code).toContain("bl _snprintf");
		expect(code).toContain('.Lsi_ffmt_string_interpolate_3_iuf: .asciz "%f"');
	});
});
