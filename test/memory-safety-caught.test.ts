import { expect, describe, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// These tests verify that the compiler catches common memory safety violations
// at compile time. They define the current safety boundary: what IS prevented.

describe("compiler-caught memory safety", () => {
	test("class-type fields must use mov", () => {
		const input = `
class Inner { var int x }
class Outer { var Inner child }
var Inner i = Inner(5)
var Outer o = Outer(i)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("mov");
	});

	test("returning class param without mov is rejected", () => {
		const input = `
class Box { var int v }
func borrow = (ref Box b, out Box) {
	return b
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("mov");
	});

	test("using variable after move is rejected", () => {
		const input = `
class Box { var int v }
class Holder { mov Box held }
var Box b = Box(42)
var Holder h = Holder(mov b)
Console.write("\\{b.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("used after move");
	});
});
