import { expect, describe, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// These tests verify that the compiler catches common memory safety violations
// at compile time. They define the current safety boundary: what IS prevented.

describe("compiler-caught memory safety", () => {
	test("class-type fields must use move", () => {
		const input = `
owning struct Inner { var int x }
owning struct Outer { var Inner child }
var Inner i = Inner(5)
var Outer o = Outer(i)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("move");
	});

	test("returning an owning-struct param through a ref borrow is rejected", () => {
		const input = `
owning struct Box { var int v }
func borrow = (ref Box b, out Box) {
	return b
}
`;
		const parsed = parse_with_imports(input);
		// B3: a bare owning-struct param is a by-VALUE copy (returning it is
		// sound), but a `ref` borrow must not escape implicitly — the return
		// names the transfer spelling.
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("move");
	});

	test("using variable after move is rejected", () => {
		const input = `
owning struct Box { var int v }
owning struct Holder { move Box held }
var Box b = Box(42)
var Holder h = Holder(move b)
Console.write("\\{b.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("used after move");
	});
});
