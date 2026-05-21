import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 022 errors2 -- errors", () => {
	const input = `
import System

enum NumberError {
  case too_small
}

pub func main = () {
  var ??? my_number = NumberError.too_small
  my_number = NumberError.too_small
  Console.write("I compiled!")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 022 errors2 -- fixed", () => {
	const input = `
import System

enum NumberError {
  case too_small
}

pub func main = () {
  var NumberError my_number = NumberError.too_small
  my_number = NumberError.too_small
  Console.write("I compiled!")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 022 errors2 -- build", async () => {
	const input = `
import System

enum NumberError {
  case too_small
}

pub func main = () {
  var NumberError my_number = NumberError.too_small
  my_number = NumberError.too_small
  Console.write("I compiled!")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("022", built, "I compiled!");
});
