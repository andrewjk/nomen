import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Buffer bounds checking: load_int/store_int have an `i >= 0 && i < self.cap`
// constraint. The compiler verifies this at compile time via flow analysis
// (e.g. cap tracked from grow_int, alias tracking for `var int c = buf.get_cap()`,
// post-loop bounds). There is no runtime clamp — out-of-bounds access is a
// compile error when provable.

describe("buffer bounds checking", () => {
	test("negative constant index is caught at compile time", () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(4)
buf.store_int(0, 111)
var int neg = buf.load_int(-1)
Console.write("\\{neg}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	test("index past capacity is caught at compile time", () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(4)
buf.store_int(0, 111)
var int past = buf.load_int(100)
Console.write("past=\\{past}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	test("write past capacity is caught at compile time", () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(2)
buf.store_int(0, 11)
buf.store_int(1, 22)
buf.store_int(5, 999)
Console.write("\\{buf.load_int(0)}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	test("verifiable in-bounds access compiles clean", async () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(4)
buf.store_int(0, 111)
buf.store_int(1, 222)
buf.store_int(2, 333)
buf.store_int(3, 444)
var int a = buf.load_int(0)
var int b = buf.load_int(3)
Console.write("\\{a} \\{b}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("oob_in_bounds", result, "111 444\n");
	});

	test("runtime index inside `if i < cap` verifies", async () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(4)
buf.store_int(0, 10)
buf.store_int(1, 20)
buf.store_int(2, 30)
buf.store_int(3, 40)
var int i = 0
var int sum = 0
while i < buf.cap {
	sum = sum + buf.load_int(i)
	i = i + 1
}
Console.write("\\{sum}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("oob_runtime_bounded", result, "100\n");
	});
});
