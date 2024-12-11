import { expect, test } from "vitest";
import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Range errors");

test("type mismatch", () => {
  const input = `
var x = 1.."b"
`;
  const expected = [test_error(input, "Type mismatch in range: string (expected int)", 2, 12)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
