import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("If/else errors");

test("string condition", () => {
  const input = `
if "hi" {
  // ...
}
`;
  const expected = [test_error(input, "If/else condition must be a bool, not string", 2, 4)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
