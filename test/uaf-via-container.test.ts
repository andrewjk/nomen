import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Generic containers now take `mov T value` on push/add/set. When T is a class,
// the caller's variable is invalidated — ownership transfers into the container.
// This prevents use-after-free: the class instance survives as long as the
// container holds it, even if the original variable's scope has ended.

describe("container ownership via mov", () => {
	test("class stored in list survives owner scope exit", async () => {
		const input = `
class Animal { var char letter }
var List<Animal> list = List<Animal>()
if true {
	var Animal a = Animal('Z')
	list.push(mov a)
}
var Animal dead = list.pop()
Console.write("got: \\{dead.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		// With mov, `a` is invalidated — its anchor is skipped at scope exit.
		// The Animal survives in the list's buffer. pop() returns a valid pointer.
		// LEAK: 1 — the container doesn't free stored values on destroy yet.
		// That's a known limitation; the type-safety guarantee (no UAF) is what matters.
		await check_output("uaf_container_scope", result, "got: Z\n");
	});

	test("same class in two lists requires explicit ownership", async () => {
		const input = `
class Animal { var char letter }
var List<Animal> l1 = List<Animal>()
var List<Animal> l2 = List<Animal>()
if true {
	var Animal a = Animal('X')
	l1.push(mov a)
	l2.push(mov a)
}
var Animal x = l1.pop()
var Animal y = l2.pop()
Console.write("\\{x.letter} \\{y.letter}\\n")
`;
		// The second push(mov a) should be a compile error — a was already moved.
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("used after move");
	});
});
