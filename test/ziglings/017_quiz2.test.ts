import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
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

	const expected_output =
		"1, 2, Fizz, 4, Buzz, Fizz, 7, 8, Fizz, Buzz, 11, Fizz, 13, 14, FizzBuzz, 16, ";
	await build_and_check_output(input, "ziglings_017", expected_output, true);
});
