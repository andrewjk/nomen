import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 017 quiz -- errors", () => {
	const input = `
import System

pub func main = () {
    var i = 1
    const stop_at = 16

    ??? i <= stop_at; i += 1 {
        if i % 3 == 0 { Console.write("Fizz") }
        if i % 5 == 0 { Console.write("Buzz") }
        if !(i % 3 == 0) && !(i % 5 == 0) {
            Console.write("\\{???}")
        }
        Console.write(", ")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 017 quiz -- fixed", () => {
	const input = `
import System

pub func main = () {
    var i = 1
    const stop_at = 16

    while i <= stop_at; i += 1 {
        if i % 3 == 0 { Console.write("Fizz") }
        if i % 5 == 0 { Console.write("Buzz") }
        if !(i % 3 == 0) && !(i % 5 == 0) {
            Console.write("\\{i}")
        }
        Console.write(", ")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 017 quiz -- build", async () => {
	const input = `
import System

pub func main = () {
    var i = 1
    const stop_at = 16

    while i <= stop_at; i += 1 {
        if i % 3 == 0 { Console.write("Fizz") }
        if i % 5 == 0 { Console.write("Buzz") }
        if !(i % 3 == 0) && !(i % 5 == 0) {
            Console.write("\\{i}")
        }
        Console.write(", ")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });

	const expected_output =
		"1, 2, Fizz, 4, Buzz, Fizz, 7, 8, Fizz, Buzz, 11, Fizz, 13, 14, FizzBuzz, 16, ";
	await check_output_aarch64("017", built, expected_output);
});
