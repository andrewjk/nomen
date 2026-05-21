import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 025 errors5 -- errors", () => {
	const input = `
import System

enum NumberResult {
  case ok
  case too_small
  case too_big
}

func detect = (int n, out NumberResult) {
  if n < 10 { return NumberResult.too_small }
  if n > 20 { return NumberResult.too_big }
  return NumberResult.ok
}

func add_five = (int n, out int, out NumberResult) {
  const NumberResult err = detect(n)
  if err != NumberResult.??? {
    return 0
  }
  return n + 5
}

pub func main = () {
  const int a = add_five(44)
  const int b = add_five(14)
  const int c = add_five(4)
  Console.write("a=\\{a}, b=\\{b}, c=\\{c}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 025 errors5 -- fixed", () => {
	const input = `
import System

enum NumberResult {
  case ok
  case too_small
  case too_big
}

func detect = (int n, out NumberResult) {
  if n < 10 { return NumberResult.too_small }
  if n > 20 { return NumberResult.too_big }
  return NumberResult.ok
}

func add_five = (int n, out int) {
  const NumberResult err = detect(n)
  if err != NumberResult.ok {
    return 0
  }
  return n + 5
}

pub func main = () {
  const int a = add_five(44)
  const int b = add_five(14)
  const int c = add_five(4)
  Console.write("a=\\{a}, b=\\{b}, c=\\{c}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 025 errors5 -- build", async () => {
	const input = `
import System

enum NumberResult {
  case ok
  case too_small
  case too_big
}

func detect = (int n, out NumberResult) {
  if n < 10 { return NumberResult.too_small }
  if n > 20 { return NumberResult.too_big }
  return NumberResult.ok
}

func add_five = (int n, out int) {
  const NumberResult err = detect(n)
  if err != NumberResult.ok {
    return 0
  }
  return n + 5
}

pub func main = () {
  const int a = add_five(44)
  const int b = add_five(14)
  const int c = add_five(4)
  Console.write("a=\\{a}, b=\\{b}, c=\\{c}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("025", built, "a=0, b=19, c=0");
});
