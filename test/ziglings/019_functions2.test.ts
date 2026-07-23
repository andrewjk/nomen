import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 019 functions2 -- errors", () => {
	const input = `
import System

pub func main = () {
    Console.write("Powers of two: \\{twoToThe(1)} \\{twoToThe(2)} \\{twoToThe(3)} \\{twoToThe(4)}")
}

func twoToThe = (??? int) {
    return Math.power(2, my_number)
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 019 functions2 -- fixed", () => {
	const input = `
import System

pub func main = () {
    Console.write("Powers of two: \\{twoToThe(1)} \\{twoToThe(2)} \\{twoToThe(3)} \\{twoToThe(4)}")
}

func twoToThe = (int my_number, out int) {
    return Math.power(2, my_number)
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 019 functions2 -- build", async () => {
	const input = `
import System

pub func main = () {
    Console.write("Powers of two: \\{twoToThe(1)} \\{twoToThe(2)} \\{twoToThe(3)} \\{twoToThe(4)}")
}

func twoToThe = (int my_number, out int) {
    return Math.power(2, my_number)
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_019", "Powers of two: 2 4 8 16", true);
});
