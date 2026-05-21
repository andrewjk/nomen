import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
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
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("019", built, "Powers of two: 2 4 8 16");
});
