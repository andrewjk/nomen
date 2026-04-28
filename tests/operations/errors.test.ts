import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Operation errors");

test("type mismatch", () => {
	const input = `
const x = 5 + "b"
`;
	const expected = [test_error(input, "Type mismatch in operation: string (expected int)", 2, 15)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("declaration type mismatch", () => {
	const input = `
const x: int = "a" + "b"
`;
	const expected = [
		test_error(input, "Type mismatch in declaration: string (expected int)", 2, 16),
	];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("assignment type mismatch", () => {
	const input = `
var x: int
x = "a" + "b"
`;
	const expected = [test_error(input, "Type mismatch in assignment: string (expected int)", 3, 5)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});
