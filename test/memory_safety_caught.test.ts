import { expect, describe, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// These tests verify that the compiler catches common memory safety violations
// at compile time. They define the current safety boundary: what IS prevented.

describe("compiler-caught memory safety", () => {
	test("class-type fields must use mv", () => {
		const input = `
mv struct Inner { var int x }
mv struct Outer { var Inner child }
var Inner i = Inner(5)
var Outer o = Outer(i)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("mv");
	});

	test("returning a mv-struct param through a ref borrow is rejected", () => {
		const input = `
mv struct Box { var int v }
func borrow = (ref Box b, out Box) {
	return b
}
`;
		const parsed = parse_with_imports(input);
		// B3: a bare mv-struct param is a by-VALUE copy (returning it is
		// sound), but a `ref` borrow must not escape implicitly — the return
		// names the transfer spelling.
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("mv");
	});

	test("using variable after mv is rejected", () => {
		const input = `
mv struct Box { var int v }
mv struct Holder { mv Box held }
var Box b = Box(42)
var Holder h = Holder(mv b)
Console.write("\\{b.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("used after mv");
	});
});
