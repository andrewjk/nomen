import { expect, describe, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// Buffer.load_int and Buffer.store_int now have `i: i >= 0` constraints that
// catch negative constant indices at compile time. Upper-bound checks are not
// possible at compile time because `cap` is a runtime value.

describe("buffer out-of-bounds access", () => {
	test("negative constant index is caught at compile time", () => {
		const input = `
var Buffer buf = Buffer()
buf.grow_int(4)
buf.store_int(0, 111)
var int neg = buf.load_int(-1)
Console.write("\\{neg}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	test("negative constant store index is caught at compile time", () => {
		const input = `
var Buffer buf = Buffer()
buf.grow_int(4)
buf.store_int(-1, 999)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	// FAILING — can't be caught at compile time because cap is a runtime value.
	// Would need runtime bounds checking to prevent.
	test("constant index past capacity should be a compile error", () => {
		const input = `
var Buffer buf = Buffer()
buf.grow_int(4)
buf.store_int(0, 111)
var int past = buf.load_int(100)
Console.write("\\{past}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	// FAILING — same reason as above.
	test("write past capacity should be a compile error", () => {
		const input = `
var Buffer buf = Buffer()
buf.grow_int(2)
buf.store_int(0, 11)
buf.store_int(5, 999)
Console.write("wrote\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});
