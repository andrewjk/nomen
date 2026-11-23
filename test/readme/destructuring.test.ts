import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("readme: destructuring", () => {
	test("tuple, array, and struct destructuring", () => {
		const input = `
struct Point {
	var int x
	var int y
}
pub func main = () {
	// Tuples — bind positionally
	func get_person = (int id, out [string, int]) {
		return ["Andrew", id + 100]
	}
	var [pname, page] = get_person(12)
	var [a, b] = [11, "hello"]

	// Arrays — bind positionally by index
	const int[] nums = [1, 2, 3]
	var [first, second, third] = nums

	// Structs and classes — bind by field name (bare name or field = name)
	const p = Point(3, 4)
	var [x, y] = p
	var [x = px, y = py] = p
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("anonymous struct destructures by field name", () => {
		const input = `
pub func main = () {
	const p = [ name = "C", x = 25, y = 70 ]
	Console.write("\\{p.name} \\{p.x} \\{p.y}")
	var [x, y] = p   // destructures by field name
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
