import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 010 if 2 -- errors", () => {
	const input = `
import System

pub func main = () -> {
    const foo = 1

    const uint8 price = if (foo) {
        17
    } else {
        20
    }

    Console.write("With the discount, the price is \\{price}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
	expect(parsed.errors.some((e: any) => e.message.includes("bool"))).toBe(true);
});

test("ziglings 010 if 2 -- fixed", () => {
	const input = `
import System

pub func main = () -> {
    const discount = true

    const uint8 price = if discount -> 17 else -> 20

    Console.write("With the discount, the price is \\{price}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 010 if 2 -- build", async () => {
	const input = `
import System

pub func main = () -> {
    const discount = true

    const uint8 price = if discount -> 17 else -> 20

    Console.write("With the discount, the price is \\{price}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });

	const expected_output = "With the discount, the price is 17.";
	await check_output_aarch64("010", built, expected_output);

	const main_start = built.code.indexOf("\nmain:\n");
	expect(main_start).toBeGreaterThan(-1);
	expect(trim_test_build(built.code.substring(main_start))).toContain("price is");
});
