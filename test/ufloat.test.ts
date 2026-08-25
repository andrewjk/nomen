import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// End-to-end coverage for unsigned floats (`ufloat`, `ufloat32`, `ufloat64`)
// across the checker and both backends: declarations with literals, arithmetic,
// casts, printing (via the System `ufloat.to_string`), and file-scope `const`
// data.

describe("ufloat", () => {
	test("declaration, arithmetic, and printing", async () => {
		const input = `
var ufloat ratio = 0.5
var ufloat scaled = ratio * 3.0
var float total = 1.5 + scaled
Console.write("\\{scaled} \\{total}\\n")
`;
		await build_and_check_output(input, "ufloat_arith", "1.500000 3.000000\n");
	});

	test("sized variants behave like their signed counterparts", async () => {
		const input = `
var ufloat32 a = 0.25
var ufloat64 b = 2.5
var float32 c = 1.5
Console.write("\\{a} \\{b} \\{c}\\n")
`;
		await build_and_check_output(input, "ufloat_sized", "0.250000 2.500000 1.500000\n");
	});

	test("explicit cast from int", async () => {
		const input = `
var ufloat u = 3 as ufloat
Console.write("\\{u}\\n")
`;
		await build_and_check_output(input, "ufloat_cast", "3.000000\n");
	});

	test("negative literal is rejected", () => {
		const parsed = parse_with_imports(`
var ufloat bad = -1.5
`);
		expect(parsed.errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
	});

	test("negating an unsigned float is an error", () => {
		const parsed = parse_with_imports(`
var ufloat u = 1.5
var ufloat n = -u
`);
		expect(parsed.errors.some((e) => e.message.includes("Cannot negate type ufloat"))).toBe(true);
	});

	test("top-level const is emitted as file-scope data", async () => {
		const input = `import System
const ufloat scale = 2.0

pub func main = () {
	var ufloat v = 1.5
	v = scale * v
	Console.write("\\{v}\\n")
}
`;
		await build_and_check_output(input, "ufloat_global_const", "3.000000\n", true);
	});
});
