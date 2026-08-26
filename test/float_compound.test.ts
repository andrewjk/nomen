import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Regression tests for float compound assignment: `x += f` on a float
// target used to emit an integer add over the raw double bit patterns
// (garbage / nan). Covers every lowering path: plain stack var,
// register-allocated float var (loop), ref param, and struct field.
describe("float compound assignment", () => {
	test("stack variable += and -= and *=", async () => {
		const input = `
var float x = 1.5
x += 2.0
x -= 0.25
x *= 4.0
Console.write(x.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("float_compound_stack", result, "13", { arch: "aarch64" });
	});

	test("loop-allocated float var +=", async () => {
		const input = `
var float total = 0.0
var int i = 0
while i < 10; i += 1 {
	total += 0.5
}
Console.write(total.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("float_compound_loop", result, "5", { arch: "aarch64" });
	});

	test("struct field +=", async () => {
		const input = `
struct Acc {
	var float sum
}
var Acc acc = Acc(0.0)
acc.sum += 1.25
acc.sum += 1.25
Console.write(acc.sum.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("float_compound_field", result, "2.5", { arch: "aarch64" });
	});

	test("ref param +=", async () => {
		const input = `
func bump = (ref float x) {
	x += 2.5
}
var float v = 1.0
bump(ref v)
bump(ref v)
Console.write(v.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		await check_output("float_compound_ref", result, "6", { arch: "aarch64" });
	});
});
