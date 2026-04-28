import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("For loop errors");

test("string list", () => {
  const input = `
for x in "hi" {
  // ...
}
`;
  const expected = [test_error(input, "For loop list must be an array, not string", 2, 10)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
