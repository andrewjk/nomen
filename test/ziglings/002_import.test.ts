import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import test_error from "../test_error";
import parse_with_imports from "./parse_with_imports";

test("ziglings 002 import -- errors", () => {
	const input = `
import ???

pub func main = () {
    Console.write("Standard Library.\\n")
}
`;
	const expected = [test_error(input, "Unknown value: Console", 5, 5)];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 002 import -- parse", () => {
	const input = `
import System

pub func main = () {
    Console.write("Standard Library.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 002 import -- build", async () => {
	const input = `
import System

pub func main = () {
    Console.write("Standard Library.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const expected_output = "Standard Library.";
	await build_and_check_output(input, "ziglings_002", expected_output, true);
});
