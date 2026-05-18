import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 008 quiz -- errors", () => {
	const input = `
import System

pub func main = () {
    const letters = "YZhifg"
    const x = 1

    var char[3] lang

    lang[0] = letters[x]

    x = 3
    lang[???] = letters[x]

    x = ???
    lang[2] = letters[???]

    Console.write("Program in \\{lang}!\\n")
}
`;
	const expected = [
		{ message: "Assignment to const: x", start: 135, line: 12, column: 5 },
		{ message: "Unknown value: ???", start: 150, line: 13, column: 10 },
		{ message: "Unknown value: ???", start: 177, line: 15, column: 9 },
		{ message: "Unknown value: ???", start: 203, line: 16, column: 23 },
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

    var char[3] lang

    lang[0] = letters[x]

    x = 3
    lang[1] = letters[x]

    x = 5
    lang[2] = letters[x]

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

    var char[3] lang

    lang[0] = letters[x]

    x = 3
    lang[1] = letters[x]

    x = 5
    lang[2] = letters[x]

    Console.write("Program in \\{lang}!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });

	const expected_output = "Program in Zig!";
	await check_output_aarch64("008", built, expected_output);

	const main_start = built.code.indexOf("\nstp x29, x30, [sp, #-16]!\nsub sp, sp, #");
	expect(main_start).toBeGreaterThan(-1);
	expect(trim_test_build(built.code.substring(main_start))).toContain('letters: .asciz "YZhifg"');
});
