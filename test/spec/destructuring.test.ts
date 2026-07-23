import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("spec: destructuring", () => {
	test("array destructuring", () => {
		const input = `
pub func main = () {
	const int[] arr = [1, 2, 3]
	var [a, b, c] = arr
	Console.write("\\{a} \\{b} \\{c}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("array destructuring out of bounds is an error", () => {
		const input = `
pub func main = () {
	var [a, b, c] = [1, 2]
}
`;
		const errors = compile_module(input);
		expect(errors.some((e) => e.message.includes("Cannot destructure index 2 of an array"))).toBe(
			true,
		);
	});

	test("discard an array position with underscore", () => {
		const input = `
pub func main = () {
	const int[] nums = [1, 2, 3]
	var [first, _, last] = nums
	Console.write("\\{first} \\{last}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("struct destructuring (bare names)", () => {
		const input = `
struct Point {
	var int x
	var int y
}
pub func main = () {
	const p = Point(3, 4)
	var [x, y] = p
	Console.write("\\{x} \\{y}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("struct destructuring (rename)", () => {
		const input = `
struct Point {
	var int x
	var int y
}
pub func main = () {
	const p = Point(3, 4)
	var [x = px, y = py] = p
	Console.write("\\{px} \\{py}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("struct destructuring (partial)", () => {
		const input = `
struct Box {
	var int width
	var int height
	var int depth
}
pub func main = () {
	const b = Box(2, 4, 6)
	var [width = w, depth = d] = b
	Console.write("\\{w} \\{d}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("class destructuring", () => {
		const input = `
class Counter {
	var int count
	var int total
}
pub func main = () {
	var c = Counter(5, 50)
	var [count = n, total = t] = c
	Console.write("\\{n} \\{t}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
