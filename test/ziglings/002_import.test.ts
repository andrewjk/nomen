import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
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
	const built = build(parsed.root, { arch: "aarch64" });
	const expected_output = "Standard Library.";
	await check_output_aarch64("002", built, expected_output);
});
