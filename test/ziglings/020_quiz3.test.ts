import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 020 quiz3 -- errors", () => {
	const input = `
import System

pub func main = () {
    const my_numbers = Array(5, 6, 7, 8)
    printPowersOfTwo(my_numbers)
}

func printPowersOfTwo = (int numbers, ???) {
    for n of numbers {
        Console.write("\\{twoToThe(n)} ")
    }
}

func twoToThe = (int number, ??? int) {
    var int n = 0
    var int total = 1

    while n < number; n += 1 {
        total *= 2
    }

    return ???
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 020 quiz3 -- fixed", () => {
	const input = `
import System

pub func main = () {
    const my_numbers = Array(5, 6, 7, 8)
    printPowersOfTwo(my_numbers)
}

func printPowersOfTwo = (Array<int> numbers) {
    for n of numbers {
        Console.write("\\{twoToThe(n)} ")
    }
}

func twoToThe = (int number, out int) {
    var int n = 0
    var int total = 1

    while n < number; n += 1 {
        total *= 2
    }

    return total
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 020 quiz3 -- build", async () => {
	const input = `
import System

pub func main = () {
    const my_numbers = Array(5, 6, 7, 8)
    printPowersOfTwo(my_numbers)
}

func printPowersOfTwo = (Array<int> numbers) {
    for n of numbers {
        Console.write("\\{twoToThe(n)} ")
    }
}

func twoToThe = (int number, out int) {
    var int n = 0
    var int total = 1

    while n < number; n += 1 {
        total *= 2
    }

    return total
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("020", built, "32 64 128 256 ");
});
