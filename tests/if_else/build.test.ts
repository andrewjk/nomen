import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("If/else build");

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
  return 50
} else {
  return 0
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

test("declaration with short if", () => {
  const input = `
const x = 10
const y = if x > 5 ~ 50
          else ~ 0
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
const y = if x > 5 ~ 50 else ~ 0
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
