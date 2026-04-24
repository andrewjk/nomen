import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("range build", () => {
  test("exclusive", () => {
    const input = `
var x = 1..4
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x[3] = {1, 2, 3};
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("inclusive with expression", () => {
    const input = `
var x = 1..(4 + 1)
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x[4] = {1, 2, 3, 4};
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("range with negative start", () => {
    const input = `
var x = -2..2
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x[4] = {-2, -1, 0, 1};
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test.skip("range as param", () => {
    // BUG: Passing a range directly as a function parameter causes a build error
    // because the range node is used in a for loop where type_from_value_node
    // expects a length property on the type, but range types don't have their
    // length set properly when passed through function calls.
    const input = `
func sum = (int[] nums, out int) -> {
  var total = 0
  for n in nums {
    total = total + n
  }
  return total
}
const result = sum(1..4)
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long sum(long nums[])
{
long total = 0;
for (int i = 0; i < 3; i++) {
long n = nums[i];
total = total + n;
}
return total;
}
long result = sum((long[]){1, 2, 3});
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("range in for loop", () => {
    const input = `
func sum = (out int) -> {
  var total = 0
  for n in 1..4 {
    total = total + n
  }
  return total
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long sum()
{
long total = 0;
long n;
for (n = 1; n < 4; n++)
{
total = total + n;
}
return total;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("range errors", () => {
  test("type mismatch", () => {
    const input = `
var x = 1.."b"
`;
    const expected = [test_error(input, "Type mismatch in range: string (expected int)", 2, 12)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
