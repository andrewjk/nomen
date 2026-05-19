import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 003 assignment -- errors", () => {
	const input = `
import System

pub func main = () {
    const uint8 n = 50
    n = n + 5

    const uint8 pi = 314159

    const uint8 negative_eleven = -11

    Console.write("\\{n} \\{pi} \\{negative_eleven}\\n")
}
`;
	const expected = [
		test_error(input, "Assignment to const: n", 6, 5),
		test_error(input, "Type mismatch in declaration: int (expected uint8)", 8, 22),
		test_error(input, "Type mismatch in declaration: int (expected uint8)", 10, 35),
	];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 003 assignment -- parse", () => {
	const input = `
import System

pub func main = () {
    var uint8 n = 50
    n = n + 5

    const float pi = 3.14159

    const int8 negative_eleven = -11

    Console.write("\\{n} \\{pi} \\{negative_eleven}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 003 assignment -- build", async () => {
	const input = `
import System

pub func main = () {
    var uint8 n = 50
    n = n + 5

    const float pi = 3.14159

    const int8 negative_eleven = -11

    Console.write("\\{n} \\{pi} \\{negative_eleven}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	const expected_output = "55 3.141590 -11";
	await check_output_aarch64("003", built, expected_output);
});
