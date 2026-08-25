import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("spec: basic types", () => {
	test("sized and unsigned numeric types with literal coercion", () => {
		const input = `
var int16 small = 300
var int doubled = small * 2
var ufloat ratio = 0.5
var ufloat scaled = ratio * 2.0
Console.write("\\{doubled} \\{scaled}\\n")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("negative literals are rejected for unsigned types", () => {
		const input = `
var ufloat ratio = -0.5
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
	});
});

describe("spec: comments", () => {
	test("single and nested block comments", () => {
		const input = `
// Single-line comment

/* Block comment
   /* nested comments supported */ */
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: array types", () => {
	test("basic array declarations", () => {
		const input = `
const int[] numbers = [1, 2, 3, 4]
const char[] letters = ['a', 'b', 'c']
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("fixed-length array", () => {
		const input = `
const int[10] buffer = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("array length access", () => {
		const input = `
const int[] numbers = [1, 2, 3, 4]
const len = numbers.length
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: Array<T> type", () => {
	test("constructors", () => {
		const input = `
const ints = Array<int>(1, 2, 3)
var Array<string> names = ["a", "b"]
const nums = Array<int>(0, 1, 2)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("static with method", () => {
		const input = `
const zeros = Array.with(0, 3)
const strs = Array<string>.with("x", 2)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: nullable types", () => {
	test("assigning null to nullable", () => {
		const input = `
var int? x = null
var string? name = null
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("nullable initialized with value", () => {
		const input = `
var int? x = 5
const y = x + 1
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("assigning null to non-nullable is an error", () => {
		const input = `
const int x = null
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("null"))).toBe(true);
	});

	test("using a null variable is an error", () => {
		const input = `
var int? x = null
const y = x + 1
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("null"))).toBe(true);
	});
});

describe("spec: reference types", () => {
	test("ref type declarations", () => {
		const input = `
struct Character { var int code }
struct Node { var int value }
func takeRef = (ref int x) { var int y = x }
func takeRefNode = (ref Node? n) { var int z = 0 }
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("reference parameters", () => {
		const input = `
func makeFive = (ref int x) {
    x = 5
}
var int num = 1
makeFive(ref num)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("calling without ref is an error", () => {
		const input = `
func makeFive = (ref int x) {
    x = 5
}
var int num = 1
makeFive(num)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("ref"))).toBe(true);
	});

	test("ref for non-ref parameter is an error", () => {
		const input = `
func print = (int x) {}
print(ref 5)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("ref"))).toBe(true);
	});

	test("const value cannot be passed to ref parameter", () => {
		const input = `
func makeFive = (ref int x) {
    x = 5
}
const int fixed = 1
makeFive(ref fixed)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("const"))).toBe(true);
	});

	test("var value can be passed to ref parameter", () => {
		const input = `
func makeFive = (ref int x) {
    x = 5
}
var int mutable = 1
makeFive(ref mutable)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: range types", () => {
	test("range expression", () => {
		const input = `
const range = 0..10
`;
		expect(compile_main(input)).toEqual([]);
	});
});
