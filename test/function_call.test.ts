import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("function call build", () => {
  test("function without params", () => {
    const input = `
func greet = () -> {}
greet()
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
void greet()
{
}
greet();
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with params", () => {
    const input = `
func greet = (string name, string position) -> {}
greet("Andrew", "Manager")
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
void greet(char* name, char* position)
{
}
greet("Andrew", "Manager");
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function call with return value", () => {
    const input = `
func add = (int a, int b, out int) -> (a + b)
const x = add(1, 2)
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long add(long a, long b)
{
return a + b;
}
long x = add(1, 2);
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function call with default param", () => {
    const input = `
func greet = (string name, string greeting = "Hello") -> {}
greet("Andrew")
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
void greet(char* name, char* greeting)
{
}
greet("Andrew");
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("function call errors", () => {
  test("function not found", () => {
    const input = `
greet()
`;
    const expected = [test_error(input, "Function not found: greet", 2, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("too many parameters", () => {
    const input = `
func greet = (int first, int second) -> {}
greet(1, 2, 3)
`;
    const expected = [test_error(input, "Too many parameters for function: greet", 3, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("parameters missing", () => {
    const input = `
func greet = (int first, int second) -> {}
greet(1)
`;
    const expected = [test_error(input, "Parameters missing for function: greet", 3, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("param type mismatch", () => {
    const input = `
func greet = (int age) -> {}
greet("andrew")
`;
    const expected = [test_error(input, "Type mismatch in param: string (expected int)", 3, 7)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("param type mismatch -- unknown value", () => {
    const input = `
func greet = (int age) -> {}
greet(z0)
`;
    const expected = [test_error(input, "Unknown value: z0", 3, 7)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
