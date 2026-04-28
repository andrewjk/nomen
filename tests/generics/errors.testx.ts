import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Generic errors");

test("unknown type", () => {
  const input = `
var x: Array<y>
`;
  const expected = [test_error(input, "Unknown type in generic: y", 2, 14)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
