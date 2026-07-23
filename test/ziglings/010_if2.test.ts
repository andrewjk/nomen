import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 010 if 2 -- errors", () => {
	const input = `
import System

pub func main = () {
    const foo = 1

    const price = if ???

    Console.write("With the discount, the price is \\{price}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 010 if 2 -- fixed", () => {
	const input = `
import System

pub func main = () {
    const discount = true

    const price = if discount -> 17 else -> 20

    Console.write("With the discount, the price is \\{price}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 010 if 2 -- build", async () => {
	const input = `
import System

pub func main = () {
    const discount = true

    const price = if discount -> 17 else -> 20

    Console.write("With the discount, the price is \\{price}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);

	const expected_output = "With the discount, the price is 17.";
	await build_and_check_output(input, "ziglings_010", expected_output, true);
});
