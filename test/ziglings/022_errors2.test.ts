import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
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
	await build_and_check_output(input, "ziglings_022", "I compiled!", true);
});
