import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 024 errors4 -- errors", () => {
	const input = `
import System

enum NumberResult {
  case ???
  case too_small
  case too_big
}

func detect_problems = (int n, out NumberResult) {
  if n < 10 { return NumberResult.too_small }
  if n > 20 { return NumberResult.too_big }
  return NumberResult.ok
}

func make_just_right = (int n, out int) {
  const NumberResult err = detect_problems(n)
  var int val = n
  if err == NumberResult.too_big {
    val = 20
  }
  if err == NumberResult.??? {
    val = 10
  }
  return val
}

pub func main = () {
  const int a = make_just_right(44)
  const int b = make_just_right(14)
  const int c = make_just_right(4)
  Console.write("a=\\{a}, b=\\{b}, c=\\{c}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 024 errors4 -- fixed", () => {
	const input = `
import System

enum NumberResult {
  case ok
  case too_small
  case too_big
}

func detect_problems = (int n, out NumberResult) {
  if n < 10 { return NumberResult.too_small }
  if n > 20 { return NumberResult.too_big }
  return NumberResult.ok
}

func make_just_right = (int n, out int) {
  const NumberResult err = detect_problems(n)
  var int val = n
  if err == NumberResult.too_big {
    val = 20
  }
  if err == NumberResult.too_small {
    val = 10
  }
  return val
}

pub func main = () {
  const int a = make_just_right(44)
  const int b = make_just_right(14)
  const int c = make_just_right(4)
  Console.write("a=\\{a}, b=\\{b}, c=\\{c}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 024 errors4 -- build", async () => {
	const input = `
import System

enum NumberResult {
  case ok
  case too_small
  case too_big
}

func detect_problems = (int n, out NumberResult) {
  if n < 10 { return NumberResult.too_small }
  if n > 20 { return NumberResult.too_big }
  return NumberResult.ok
}

func make_just_right = (int n, out int) {
  const NumberResult err = detect_problems(n)
  var int val = n
  if err == NumberResult.too_big {
    val = 20
  }
  if err == NumberResult.too_small {
    val = 10
  }
  return val
}

pub func main = () {
  const int a = make_just_right(44)
  const int b = make_just_right(14)
  const int c = make_just_right(4)
  Console.write("a=\\{a}, b=\\{b}, c=\\{c}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("024", built, "a=20, b=14, c=10");
});
