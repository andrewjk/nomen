import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Array errors");

test("declaration type mismatch", () => {
	const input = `
const x: int[] = ["a", "b", "c"]
`;
	const expected = [
		test_error(input, "Type mismatch in array: string (expected int)", 2, 19),
		test_error(input, "Type mismatch in array: string (expected int)", 2, 24),
		test_error(input, "Type mismatch in array: string (expected int)", 2, 29),
	];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("declaration type mixed", () => {
	const input = `
const x = [1, "b", 2]
`;
	const expected = [test_error(input, "Type mismatch in array: string (expected int)", 2, 15)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("declaration type not an array", () => {
	const input = `
const x: int[] = 5
`;
	const expected = [test_error(input, "Type mismatch in declaration: int (expected int[])", 2, 18)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("assignment type mismatch", () => {
	const input = `
var x: int[]
x = ["a", "b", "c"]
`;
	const expected = [
		test_error(input, "Type mismatch in array: string (expected int)", 3, 6),
		test_error(input, "Type mismatch in array: string (expected int)", 3, 11),
		test_error(input, "Type mismatch in array: string (expected int)", 3, 16),
	];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("assignment type mixed", () => {
	const input = `
var x: int[]
x = [1, "b", 2]
`;
	const expected = [test_error(input, "Type mismatch in array: string (expected int)", 3, 9)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("assignment type not an array", () => {
	const input = `
var x: int[]
x = 5
`;
	const expected = [test_error(input, "Type mismatch in assignment: int (expected int[])", 3, 5)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});
