import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// FAILING TESTS — these demonstrate known memory safety gaps.
//
// Generic containers store class pointers as borrowed references (type-erased
// to int). When the owning variable goes out of scope, the container holds a
// dangling pointer. Retrieving and using it is a use-after-free.
//
// The desired behavior: either (a) storing a class in a container should
// transfer ownership so the container keeps it alive, or (b) the compiler
// should reject the pattern at compile time. Until one of these is implemented,
// these tests fail.

describe("container use-after-free (FAILING — known gap)", () => {
	test("class stored in list survives owner scope exit", async () => {
		const input = `
class Animal { var char letter }
var List<Animal> list = List<Animal>()
if true {
	var Animal a = Animal('Z')
	list.push(a)
}
var Animal dead = list.pop()
Console.write("got: \\{dead.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		// SHOULD print "got: Z" with no leaks. ACTUALLY prints garbage
		// ("got: \x02") because the Animal was freed when the if-block
		// ended, and reports LEAK: -1 (double-free).
		await check_output("uaf_container_scope", result, "got: Z\n");
	});

	test("same class in two lists — both valid after owner scope", async () => {
		const input = `
class Animal { var char letter }
var List<Animal> l1 = List<Animal>()
var List<Animal> l2 = List<Animal>()
if true {
	var Animal a = Animal('X')
	l1.push(a)
	l2.push(a)
}
var Animal x = l1.pop()
var Animal y = l2.pop()
Console.write("\\{x.letter} \\{y.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		// SHOULD print "X X". ACTUALLY reads freed memory.
		await check_output("uaf_shared_instance", result, "X X\n");
	});
});
