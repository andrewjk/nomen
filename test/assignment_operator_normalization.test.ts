import { describe, expect, test } from "vite-plus/test";

import AssignmentNode from "../src/nodes/AssignmentNode";
import ValueNode from "../src/nodes/ValueNode";
import build_and_check_output from "./build_and_check_output";

// A plain `=` assignment is represented as `operator === undefined` (the
// parser strips it). Programmatically-built ASTs (auto-derived method bodies)
// may pass the literal `"="`; the AssignmentNode constructor normalizes it so
// the backends' `!operator` plain-vs-compound branches agree. Regression:
// auto_derive's synthesized `copy` passed `"="`, which sent the aarch64
// field-store path down its compound/scalar branch and corrupted a `List<T>`
// member (single-word store) instead of copying the 32-byte value.
describe("plain assignment operator normalization", () => {
	test("explicit '=' normalizes to no operator", () => {
		const node = new AssignmentNode(-1, new ValueNode(-1, "x"), new ValueNode(-1, "1"), "=");
		expect(node.operator).toBeUndefined();
	});

	test("compound operators are preserved", () => {
		const node = new AssignmentNode(-1, new ValueNode(-1, "x"), new ValueNode(-1, "1"), "+=");
		expect(node.operator).toBe("+=");
	});

	test("omitted operator stays undefined", () => {
		const node = new AssignmentNode(-1, new ValueNode(-1, "x"), new ValueNode(-1, "1"));
		expect(node.operator).toBeUndefined();
	});

	test("a derived copy still round-trips a List field", async () => {
		const input = `
struct Rule {
	var name = ""
	var protocols = List<string>()
}
var a = Rule()
a.name = "href"
a.protocols.push("http")
var b = a.copy()
b.protocols.push("ftp")
Console.write("a=\\{a.name}/\\{a.protocols.length} b=\\{b.name}/\\{b.protocols.length}\\n")
`;
		await build_and_check_output(input, "derived_copy_operator", "a=href/1 b=href/2\n");
	});
});
