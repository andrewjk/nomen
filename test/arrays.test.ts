import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("array build", () => {
  test("declaration with type", () => {
    const input = `
const int[] x
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x[];
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("declaration with value", () => {
    const input = `
var x = [1, 2, 3]
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x[3] = {1, 2, 3};
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("declaration with type and value", () => {
    const input = `
const int[] x = [1, 2, 3]
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x[3] = {1, 2, 3};
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("array access", () => {
    const input = `
const nums = [10, 20, 30]
const x = nums[1]
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long nums[3] = {10, 20, 30};
long x = nums[1];
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test.skip("array in function param", () => {
    // BUG: Same as range param - for loop over function param arrays
    // causes undefined allocations in build_node
    const input = `
func sum = (int[] nums, out int) -> {
  var total = 0
  for n in nums {
    total = total + n
  }
  return total
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long sum(long nums[])
{
long total = 0;
long n;
for (n = 0; n < 3; n++)
{
sum = sum + n;
}
return total;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("array errors", () => {
  test("declaration type mismatch", () => {
    const input = `
const int[] x = ["a", "b", "c"]
`;
    const expected = [
      test_error(input, "Type mismatch in array: string (expected int)", 2, 18),
      test_error(input, "Type mismatch in array: string (expected int)", 2, 23),
      test_error(input, "Type mismatch in array: string (expected int)", 2, 28),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("declaration type mixed", () => {
    const input = `
const x = [1, "b", 2]
`;
    const expected = [test_error(input, "Type mismatch in array: string (expected int)", 2, 15)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("declaration type not an array", () => {
    const input = `
const int[] x = 5
`;
    const expected = [test_error(input, "Type mismatch in declaration: int (expected int[])", 2, 17)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("assignment type mismatch", () => {
    const input = `
var int[] x
x = ["a", "b", "c"]
`;
    const expected = [
      test_error(input, "Type mismatch in array: string (expected int)", 3, 6),
      test_error(input, "Type mismatch in array: string (expected int)", 3, 11),
      test_error(input, "Type mismatch in array: string (expected int)", 3, 16),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("assignment type mixed", () => {
    const input = `
var int[] x
x = [1, "b", 2]
`;
    const expected = [test_error(input, "Type mismatch in array: string (expected int)", 3, 9)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("assignment type not an array", () => {
    const input = `
var int[] x
x = 5
`;
    const expected = [test_error(input, "Type mismatch in assignment: int (expected int[])", 3, 5)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
