import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("for loop build", () => {
  test("with array", () => {
    const input = `
const y = [1, 2, 3]
for x in y {
  x = x + 1
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long y[3] = {1, 2, 3};
long x;
for (x = 0; x < 3; x++)
{
x = x + 1;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("with range", () => {
    const input = `
for x in 0..5 {
  x = x + 1
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x;
for (x = 0; x < 5; x++)
{
x = x + 1;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("with body", () => {
    const input = `
const nums = [1, 2, 3]
var sum = 0
for n in nums {
  sum = sum + n
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long nums[3] = {1, 2, 3};
long sum = 0;
long n;
for (n = 0; n < 3; n++)
{
sum = sum + n;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("for loop errors", () => {
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
});
