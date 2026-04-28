import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Access errors");

test("type mismatch getting field", () => {
	const input = `
struct Person {
  var name: string
}
var p: Person
var x: int = p.name
`;
	const expected = [
		test_error(input, "Type mismatch in declaration: string (expected int)", 6, 14),
	];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("type mismatch setting field", () => {
	const input = `
struct Person {
  var age: int
}
var p: Person
p.age = "hi"
`;
	const expected = [test_error(input, "Type mismatch in assignment: string (expected int)", 6, 9)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("unknown target", () => {
	const input = `
var age = person.age
`;
	const expected = [test_error(input, "Unknown value: person", 2, 11)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});
