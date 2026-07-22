import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// PARSE
describe("destructuring parse", () => {
	test("parse array destructuring", () => {
		const input = `
const int[] arr = [1, 2, 3]
var [a, b, c] = arr
`;
		// Array .at() resolution needs the System library + function scope.
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("parse struct destructuring (bare names)", () => {
		const input = `
struct Point {
	var int x
	var int y
}
const p = Point(1, 2)
var [x, y] = p
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("parse struct destructuring (rename)", () => {
		const input = `
struct Point {
	var int x
	var int y
}
const p = Point(1, 2)
var [x = px, y = py] = p
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("parse class destructuring", () => {
		const input = `
class Point {
	var int x
	var int y
}
var p = Point(1, 2)
var [x, y] = p
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});

// TYPE CHECK ERRORS
describe("destructuring errors", () => {
	test("array destructure with rename is an error", () => {
		const input = `
const int[] arr = [1, 2, 3]
var [a = first] = arr
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("Cannot rename elements"))).toBe(true);
	});

	test("struct destructure with unknown field is an error", () => {
		const input = `
struct Point {
	var int x
	var int y
}
const p = Point(1, 2)
var [w] = p
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("Field not found"))).toBe(true);
	});

	test("struct destructure rename with unknown field is an error", () => {
		const input = `
struct Point {
	var int x
	var int y
}
const p = Point(1, 2)
var [missing = m] = p
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("Field 'missing' not found"))).toBe(true);
	});
});

// BUILD & RUN — ARRAY
describe("array destructuring", () => {
	test("destructure int array", async () => {
		const input = `
const int[] arr = [1, 2, 3]
var [a, b, c] = arr
Console.write("\\{a} \\{b} \\{c}")
`;
		await build_and_check_output(input, "arr_destructure", "1 2 3");
	});

	test("destructure two-element array", async () => {
		const input = `
const int[] nums = [10, 20]
var [first, second] = nums
Console.write("\\{first} \\{second}")
`;
		await build_and_check_output(input, "arr_destructure_two", "10 20");
	});

	test("destructure string array", async () => {
		const input = `
const string[] names = ["alpha", "beta", "gamma"]
var [a, b, c] = names
Console.write("\\{a}\\{b}\\{c}")
`;
		await build_and_check_output(input, "arr_destructure_str", "alphabetagamma");
	});

	test("destructure from range", async () => {
		const input = `
const range = 5..8
var [a, b, c] = range
Console.write("\\{a} \\{b} \\{c}")
`;
		await build_and_check_output(input, "arr_destructure_range", "5 6 7");
	});
});

// BUILD & RUN — STRUCT
describe("struct destructuring", () => {
	test("destructure struct by field name", async () => {
		const input = `
struct Point {
	var int x
	var int y
}
const p = Point(3, 4)
var [x, y] = p
Console.write("\\{x} \\{y}")
`;
		await build_and_check_output(input, "struct_destructure", "3 4");
	});

	test("destructure struct with rename", async () => {
		const input = `
struct Point {
	var int x
	var int y
}
const p = Point(3, 4)
var [x = px, y = py] = p
Console.write("\\{px} \\{py}")
`;
		await build_and_check_output(input, "struct_destructure_rename", "3 4");
	});

	test("destructure struct partially", async () => {
		const input = `
struct Box {
	var int width
	var int height
	var int depth
}
const b = Box(2, 4, 6)
var [width = w, depth = d] = b
Console.write("\\{w} \\{d}")
`;
		await build_and_check_output(input, "struct_destructure_partial", "2 6");
	});

	test("destructure struct with string field", async () => {
		const input = `
struct Person {
	var string name
	var int age
}
const p = Person("Ada", 30)
var [name, age] = p
Console.write("\\{name} \\{age}")
`;
		await build_and_check_output(input, "struct_destructure_str", "Ada 30");
	});
});

// BUILD & RUN — CLASS
describe("class destructuring", () => {
	test("destructure class by field name", async () => {
		const input = `
class Point {
	var int x
	var int y
}
var p = Point(7, 8)
var [x, y] = p
Console.write("\\{x} \\{y}")
`;
		await build_and_check_output(input, "class_destructure", "7 8");
	});

	test("destructure class with rename", async () => {
		const input = `
class Counter {
	var int count
	var int total
}
var c = Counter(5, 50)
var [count = n, total = t] = c
Console.write("\\{n} \\{t}")
`;
		await build_and_check_output(input, "class_destructure_rename", "5 50");
	});
});
