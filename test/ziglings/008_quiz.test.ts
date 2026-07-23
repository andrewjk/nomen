import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import test_error from "../test_error";
import parse_with_imports from "./parse_with_imports";

test("ziglings 008 quiz -- errors", () => {
	const input = `
import System

pub func main = () {
    const letters = "YZhifg"
    const x = 1

    var lang = Array.with(' ', 3)

    lang.set(0, letters.at(x))

    x = 3
    lang.set(???, letters.at(x))

    x = ???
    lang.set(2, letters.at(???))

    Console.write("Program in \\{lang}!\\n")
}
`;
	const expected = [
		test_error(input, "Assignment to const: x", 12, 5),
		test_error(input, "Unknown value: ???", 13, 14),
		test_error(input, "Unknown value: ???", 15, 9),
		test_error(input, "Unknown value: ???", 16, 28),
	];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 008 quiz -- fixed", () => {
	const input = `
import System

pub func main = () {
    const letters = "YZhifg"
    var x = 1

    var lang = Array.with(' ', 3)

    lang.set(0, letters.at(x))

    x = 3
    lang.set(1, letters.at(x))

    x = 5
    lang.set(2, letters.at(x))

    Console.write("Program in \\{lang}!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 008 quiz -- build", async () => {
	const input = `
import System

pub func main = () {
    const letters = "YZhifg"
    var x = 1

    var lang = Array.with(' ', 3)

    lang.set(0, letters.at(x))

    x = 3
    lang.set(1, letters.at(x))

    x = 5
    lang.set(2, letters.at(x))

    Console.write("Program in \\{lang}!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const expected_output = "Program in Zig!";
	await build_and_check_output(input, "ziglings_008", expected_output, true);
});
