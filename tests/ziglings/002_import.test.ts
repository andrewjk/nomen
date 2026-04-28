import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import trim_code from "./trim_code";

test("ziglings 002 import -- errors", () => {
  const input = `
import ???

pub func main() {
    Console.write("Standard Library.\n")
}
`;
  const expected = [test_error(input, "Unknown value: Console", 5, 5)];
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

test("ziglings 002 import -- build", async () => {
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

  const expected_output = "Standard Library.";
  await check_output("002", built, expected_output);
});
