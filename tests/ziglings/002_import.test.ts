import { expect, test } from "vitest";
import build from "../../src/build";
import type CompileError from "../../src/types/CompileError";
import parse_with_imports from "./parse_with_imports";
import trim_code from "./trim_code";

test("ziglings 002 import -- errors", () => {
  const input = `
import ???

pub func main() {
    Console.write("Standard Library.\n")
}
`;
  const expected: CompileError[] = [
    {
      message: "Unknown target: Console",
      start: 35,
    },
  ];
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual(expected);
});

test("ziglings 002 import -- parse", () => {
  const input = `
import System

pub func main() {
    Console.write("Standard Library.\\n")
}
`;
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual([]);
});

test("ziglings 002 import -- build", () => {
  const input = `
import System

pub func main() {
    Console.write("Standard Library.\\n")
}
`;
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual([]);
  const built = build(parsed.root);
  const expected = `
int main()
{
Console_write("Standard Library.\\n");
}
`;
  expect(trim_code(built.code)).toEqual(expected.trim());
});
