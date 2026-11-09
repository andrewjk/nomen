import { describe, expect, test } from "vite-plus/test";

import AccessNode from "../src/nodes/AccessNode";
import type BaseNode from "../src/nodes/BaseNode";
import FunctionCallNode from "../src/nodes/FunctionCallNode";
import ValueNode from "../src/nodes/ValueNode";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";
import { compile_main } from "./spec/_helpers";

// Compile-time-checked format specs on string interpolation (`\{expr:spec}`):
// the checker validates each spec against the argument's type (precision on
// floats, base on integers, zero-padding on numerics only) and lowers the
// argument into a System `Format` call, so the interpolation helper keeps
// receiving an ordinary owned string. Every program here is built AND run on
// both backends; the expected output is spelled exactly.

const FORMATS_PROGRAM = `
var int i = 42
var int neg = -7
var uint64 u = 18446744073709551615
var int8 small = -3
var uint8 usmall = 250
var float f = 1.5
var string name = "Gojo"
var bool flag = true
var char grade = 'A'
Console.write("fixed \\{f:.2}\\n")
Console.write("width \\{f:>10.3}\\n")
Console.write("zero \\{f:08.2}\\n")
Console.write("left \\{f:<8.1}|\\n")
Console.write("pad \\{name:>8}|\\n")
Console.write("padl \\{name:<8}|\\n")
Console.write("hex \\{i:x} \\{i:X}\\n")
Console.write("bin \\{i:b} oct \\{i:o}\\n")
Console.write("zint \\{i:03} \\{neg:03}\\n")
Console.write("neghex \\{neg:x}\\n")
Console.write("u64 \\{u:x}\\n")
Console.write("small \\{small:03} \\{usmall:02}\\n")
Console.write("flag \\{flag:>4}| \\{grade:>2}|\\n")
Console.write("expr \\{i * 2:04}\\n")
Console.write("mix \\{name}: \\{i:04} (\\{f:.2})\\n")
Console.write("plain \\{i} stays \\{name}\\n")
`;

describe("format specs", () => {
	test(
		"float precision, integer base, padding, and plain args render exactly (both backends)",
		{ timeout: 120_000 },
		async () => {
			await build_and_check_output(
				FORMATS_PROGRAM,
				"format_specs",
				"fixed 1.50\n" +
					"width      1.500\n" +
					"zero 00001.50\n" +
					"left 1.5     |\n" +
					"pad     Gojo|\n" +
					"padl Gojo    |\n" +
					"hex 2a 2A\n" +
					"bin 101010 oct 52\n" +
					"zint 042 -07\n" +
					"neghex -7\n" +
					"u64 ffffffffffffffff\n" +
					"small -03 250\n" +
					"flag true|  A|\n" +
					"expr 0084\n" +
					"mix Gojo: 0042 (1.50)\n" +
					"plain 42 stays Gojo\n",
			);
		},
	);

	test("spec'd arguments lower to Format calls under an all-string helper", () => {
		const parsed = parse_with_imports(FORMATS_PROGRAM);
		expect(parsed.errors).toEqual([]);
		// Collect the interpolation calls. A call that CARRIES specs must keep
		// its unsuffixed (all-string) helper name — every spec'd argument was
		// rewritten into a `Format.*` call before the kinds pass. Calls
		// without specs may still take writer-form kinds (plain `\{i}`).
		const interp_calls: FunctionCallNode[] = [];
		let format_calls = 0;
		const visit = (node: BaseNode | undefined | null) => {
			if (!node || typeof node !== "object") return;
			if (
				node.node_type === "func_call" &&
				(node as FunctionCallNode).name.startsWith("_string_interpolate_")
			) {
				interp_calls.push(node as FunctionCallNode);
			}
			if (
				node.node_type === "access" &&
				(node as AccessNode).target?.node_type === "value" &&
				((node as AccessNode).target as ValueNode).value === "Format"
			) {
				format_calls += 1;
			}
			for (const key of Object.keys(node)) {
				if (key === "parent" || key === "scope") continue;
				const value = (node as unknown as Record<string, unknown>)[key];
				if (Array.isArray(value)) {
					for (const item of value) visit(item as BaseNode);
				} else if (value && typeof value === "object" && "node_type" in value) {
					visit(value as BaseNode);
				}
			}
		};
		visit(parsed.root);
		expect(interp_calls.length).toBeGreaterThan(5);
		for (const call of interp_calls) {
			if (call.format_specs?.some(Boolean)) {
				expect(call.name).toMatch(/^_string_interpolate_\d+$/);
			}
		}
		// The Format lowerings actually happened: the program exercises
		// float_fixed, int_base, uint_base, and pad.
		expect(format_calls).toBeGreaterThanOrEqual(4);
	});
});

describe("format spec errors", () => {
	test("precision requires a float", () => {
		const errors = compile_main(`
var int i = 5
Console.write("\\{i:.2}")
`);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("precision requires a float");
		expect(errors[0].message).toContain(":.2");
	});

	test("base requires an integer", () => {
		const errors = compile_main(`
var float f = 1.5
Console.write("\\{f:x}")
`);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("base requires an integer");
	});

	test("base requires an integer (strings included)", () => {
		const errors = compile_main(`
var string s = "x"
Console.write("\\{s:b}")
`);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("base requires an integer");
	});

	test("zero-padding requires an integer or float", () => {
		const errors = compile_main(`
var string s = "x"
Console.write("\\{s:03}")
`);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("zero-padding requires an integer or float");
	});

	test("syntax: empty alignment", () => {
		const errors = compile_main(`
var int i = 5
Console.write("\\{i:<}")
`);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("invalid format spec");
	});

	test("syntax: zero without width", () => {
		const errors = compile_main(`
var int i = 5
Console.write("\\{i:0}")
`);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("expected width digits after '0'");
	});

	test("syntax: unexpected character", () => {
		const errors = compile_main(`
var int i = 5
Console.write("\\{i:3q}")
`);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("unexpected character 'q'");
	});

	test("syntax: precision and base cannot combine", () => {
		const errors = compile_main(`
var int i = 5
Console.write("\\{i:8.2x}")
`);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("precision and base cannot combine");
	});

	test("syntax: spec without an expression", () => {
		const errors = compile_main(`
var int i = 5
Console.write("\\{:8}")
`);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("requires an expression before ':'");
	});
});
