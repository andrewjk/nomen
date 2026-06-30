import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Regression coverage for class/string reassignment inside a loop across the
// different codegen paths. The constructor path was fixed (anchor in the
// variable's declaration frame); these exercise the other paths. Each must keep
// the live value across iterations with a balanced audit count.

describe("reassignment paths inside a loop", () => {
	test("heap-returning factory function", async () => {
		const input = `
class Box { var int v }
class Holder { mov Box c }
func mk = (int n, out Holder) {
    return Holder(mov Box(n))
}
var Holder h = Holder(mov Box(0))
var int i = 1
while i <= 5 {
    h = mk(i)
    i = i + 1
}
Console.write("\\{h.c.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("loop_reassign_factory", result, "5\n", { audit: true });
	});

	test("ref param reassigned by a function called in a loop", async () => {
		const input = `
class Box { var int v }
class Holder { mov Box c }
func replace = (ref Holder h, int n) {
    h = Holder(mov Box(n))
}
var Holder h = Holder(mov Box(0))
var int i = 1
while i <= 5 {
    replace(ref h, i)
    i = i + 1
}
Console.write("\\{h.c.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("loop_reassign_refparam", result, "5\n", { audit: true });
	});

	test("string reassignment in a loop", async () => {
		const input = `
var string s = "start"
var int i = 1
while i <= 3 {
    s = "iter\\{i}"
    i = i + 1
}
Console.write("\\{s}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("loop_reassign_string", result, "iter3\n", { audit: true });
	});

	test("constructor reassignment in a nested if inside a loop", async () => {
		const input = `
class Box { var int v }
class Holder { mov Box c }
var Holder h = Holder(mov Box(0))
var int i = 1
while i <= 5 {
    if i > 2 {
        h = Holder(mov Box(i))
    }
    i = i + 1
}
Console.write("\\{h.c.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("loop_reassign_nested_if", result, "5\n", { audit: true });
	});
});
