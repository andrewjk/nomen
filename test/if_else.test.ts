import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("if/else build", () => {
  test("if", () => {
    const input = `
var x = 10
if x > 5 {
  x = 15
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 10;
if (x > 5) {
x = 15;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("if else", () => {
    const input = `
var x = 10
if x > 5 {
  x = 15
} else {
  x = 20
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 10;
if (x > 5) {
x = 15;
} else {
x = 20;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("declaration with if", () => {
    const input = `
const x = 10
const y = if x > 5 {
  let 50
} else {
  let 0
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 10;
long y;
if (x > 5) {
y = 50;
} else {
y = 0;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("declaration with one line if", () => {
    const input = `
const x = 10
const y = if x > 5 -> (50) else -> (0)
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 10;
long y;
if (x > 5) {
y = 50;
} else {
y = 0;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("declaration with one line if with operation", () => {
    const input = `
const x = 10
const y = if x > 5 -> (x + 1) else -> (x - 1)
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 10;
long y;
if (x > 5) {
y = x + 1;
} else {
y = x - 1;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("if without else", () => {
    const input = `
var x = 10
if x > 5 {
  x = 15
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 10;
if (x > 5) {
x = 15;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("if/else errors", () => {
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
});
