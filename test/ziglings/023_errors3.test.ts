import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 023 errors3 -- errors", () => {
	const input = `
import System

enum NumberResult {
  case ok
  case too_small
}

func check_number = (int n, out NumberResult) {
  if n < 5 { return NumberResult.too_small }
  return NumberResult.ok
}

pub func main = () {
  const NumberResult result = check_number(44)
  const int a = match result {
    case .ok -> 64
    ??? -> 22
  }

  const NumberResult result2 = check_number(4)
  const int b = match result2 {
    case .ok -> 24
    case .too_small -> ???
  }

  Console.write("a=\\{a}, b=\\{b}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 023 errors3 -- fixed", () => {
	const input = `
import System

enum NumberResult {
  case ok
  case too_small
}

func check_number = (int n, out NumberResult) {
  if n < 5 { return NumberResult.too_small }
  return NumberResult.ok
}

pub func main = () {
  const NumberResult result = check_number(44)
  const int a = match result {
    case .ok -> 64
    else -> 22
  }

  const NumberResult result2 = check_number(4)
  const int b = match result2 {
    case .ok -> 24
    else -> 22
  }

  Console.write("a=\\{a}, b=\\{b}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 023 errors3 -- build", async () => {
	const input = `
import System

enum NumberResult {
  case ok
  case too_small
}

func check_number = (int n, out NumberResult) {
  if n < 5 { return NumberResult.too_small }
  return NumberResult.ok
}

pub func main = () {
  const NumberResult result = check_number(44)
  const int a = match result {
    case .ok -> 64
    else -> 22
  }

  const NumberResult result2 = check_number(4)
  const int b = match result2 {
    case .ok -> 24
    else -> 22
  }

  Console.write("a=\\{a}, b=\\{b}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("023", built, "a=64, b=22");
});
