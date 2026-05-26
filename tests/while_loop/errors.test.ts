import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("While loop errors");

test("string condition", () => {
	const input = `
while "hi" {
  // ...
}
`;
	const expected = [test_error(input, "While loop condition must be a bool, not string", 2, 7)];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});
