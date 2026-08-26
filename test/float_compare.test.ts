import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// fcmp-based float comparisons: IEEE semantics (NaN compares false for
// ordered conditions, -0.0 == +0.0) where the historical raw bit-pattern
// integer cmp gave wrong answers, exercised through both the value path
// (materialized bool) and the branch path (if/while conditions).
describe("float comparisons via fcmp", () => {
	test("ordered comparisons of mixed-sign values", async () => {
		const input = `
var float a = -2.5
var float b = 0.5
if a < b { Console.write("lt\\n") }
if a <= b { Console.write("le\\n") }
if b > a { Console.write("gt\\n") }
if b >= a { Console.write("ge\\n") }
if a != b { Console.write("ne\\n") }
if a == b { Console.write("eq_wrong\\n") }
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("fcmp_ordered", result, "lt\nle\ngt\nge\nne\n", { arch: "aarch64" });
	});

	test("equality of equal values and self-comparison", async () => {
		const input = `
var float x = 1.25
var float y = 1.25
if x == y { Console.write("eq\\n") }
if x >= y { Console.write("ge\\n") }
if x <= y { Console.write("le\\n") }
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("fcmp_equal", result, "eq\nge\nle\n", { arch: "aarch64" });
	});

	test("materialized bool (value path) of a float comparison", async () => {
		const input = `
var float a = 3.5
var float b = 1.0
const bool c = a > b
Console.write(c.to_string())
Console.write("\\n")
const bool d = a < b
Console.write(d.to_string())
Console.write("\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("fcmp_value", result, "true\nfalse\n", { arch: "aarch64" });
	});

	test("while condition with float comparison", async () => {
		const input = `
var float x = 4.0
var int n = 0
while x > 0.5 {
	x = x * 0.5
	n += 1
}
Console.write(n.to_string())
Console.write("\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("fcmp_while", result, "3\n", { arch: "aarch64" });
	});

	test("comparison of float expression results (non-simple operands)", async () => {
		const input = `
var float a = 1.5
var float b = 2.5
if a * 2.0 < b + 1.5 { Console.write("expr_lt\\n") }
if a + b >= 3.5 { Console.write("expr_ge\\n") }
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("fcmp_expr", result, "expr_lt\nexpr_ge\n", { arch: "aarch64" });
	});

	test("unary minus on a float variable", async () => {
		const input = `
var float x = 2.5
var float y = -x
Console.write(y.to_string())
Console.write("\\n")
if -x < x { Console.write("neg_lt\\n") }
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("fneg_var", result, "-2.500000\nneg_lt\n", { arch: "aarch64" });
	});
});
