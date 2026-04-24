import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("while loop build", () => {
  test("while", () => {
    const input = `
var x = 0
while x < 5 {
  x = x + 1
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 0;
while (x < 5) {
x = x + 1;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("while true", () => {
    const input = `
while true {
  // ...
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
while (true) {
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("while with break", () => {
    const input = `
var x = 0
while true {
  x = x + 1
  if x >= 5 {
    break
  }
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 0;
while (true) {
x = x + 1;
if (x >= 5) {
break;
}
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("while with continue", () => {
    const input = `
var x = 0
while x < 10 {
  x = x + 1
  if x % 2 == 0 {
    continue
  }
  x = x * 2
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 0;
while (x < 10) {
x = x + 1;
if (x % 2 == 0) {
continue;
}
x = x * 2;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("while loop errors", () => {
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
});
