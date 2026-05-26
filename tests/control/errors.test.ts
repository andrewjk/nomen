import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Control errors");

test("break outside loop", () => {
	const input = `
func add() -> int {
  break
  return 5
}
`;
	const expected = [test_error(input, "Break must be inside a for or while loop", 3, 3)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("continue outside loop", () => {
	const input = `
func add() -> int {
  continue
  return 5
}
`;
	const expected = [test_error(input, "Continue must be inside a for or while loop", 3, 3)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("panic without a message", () => {
	const input = `
func add() -> int {
  panic
}
`;
	const expected = [test_error(input, "Expected a panic message", 4, 1)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("todo without a message", () => {
	const input = `
func add() -> int {
  todo
}
`;
	const expected = [test_error(input, "Expected a todo message", 4, 1)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});
