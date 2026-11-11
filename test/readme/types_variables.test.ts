import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

describe("readme: data types", () => {
	test("basic types", () => {
		const input = `
const i = 1
const uint u = 2
const int8 small = 3
const f = 3.0
const s = "hello"
const c = 'h'
const ready = true
const int[] arr = [1, 2, 3]
var int? maybe = null
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: variables", () => {
	test("const, var, and inference", () => {
		const input = `
const name = "Alice"
var age = 30
var count = 10
`;
		expect(compile_main(input)).toEqual([]);
	});
});
