import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 021 errors -- errors", () => {
	const input = `
import System

enum NumberError {
  case too_big
  case ???
  case too_four
}

func number_fail = (int n, out NumberError) {
  if n > 4 { return NumberError.too_big }
  if n < 4 { return NumberError.too_small }
  return NumberError.too_four
}

pub func main = () {
  const nums = Array(5, 3, 4)
  for n of nums {
    const err = number_fail(n)
    if err == NumberError.too_big {
      Console.write(">4. ")
    }
    if ???.too_small {
      Console.write("<4. ")
    }
    if err == NumberError.too_four {
      Console.write("=4. ")
    }
  }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 021 errors -- fixed", () => {
	const input = `
import System

enum NumberError {
  case too_big
  case too_small
  case too_four
}

func number_fail = (int n, out NumberError) {
  if n > 4 { return .too_big }
  if n < 4 { return .too_small }
  return .too_four
}

pub func main = () {
  const nums = Array(5, 3, 4)
  for n of nums {
    const err = number_fail(n)
    if err == .too_big {
      Console.write(">4. ")
    }
    if err == .too_small {
      Console.write("<4. ")
    }
    if err == .too_four {
      Console.write("=4. ")
    }
  }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 021 errors -- build", async () => {
	const input = `
import System

enum NumberError {
  case too_big
  case too_small
  case too_four
}

func number_fail = (int n, out NumberError) {
  if n > 4 { return .too_big }
  if n < 4 { return .too_small }
  return .too_four
}

pub func main = () {
  const nums = Array(5, 3, 4)
  for n of nums {
    const err = number_fail(n)
    if err == .too_big {
      Console.write(">4. ")
    }
    if err == .too_small {
      Console.write("<4. ")
    }
    if err == .too_four {
      Console.write("=4. ")
    }
  }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("021", built, ">4. <4. =4. ");
});
