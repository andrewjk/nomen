import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 009 if -- errors", () => {
	const input = `
import System

pub func main = () -> {
    const foo = 1

    if (foo) {
        Console.write("Foo is 1!\\n")
    } else {
        Console.write("Foo is not 1!\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
	expect(parsed.errors.some((e: any) => e.message.includes("bool"))).toBe(true);
});

test("ziglings 009 if -- fixed", () => {
	const input = `
import System

pub func main = () -> {
    const foo = 1

    if (foo == 1) {
        Console.write("Foo is 1!\\n")
    } else {
        Console.write("Foo is not 1!\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 009 if -- build", async () => {
	const input = `
import System

pub func main = () -> {
    const foo = 1

    if (foo == 1) {
        Console.write("Foo is 1!\\n")
    } else {
        Console.write("Foo is not 1!\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });

	const expected_output = "Foo is 1!";
	await check_output_aarch64("009", built, expected_output);

	const main_start = built.code.indexOf("\nmain:\n");
	expect(main_start).toBeGreaterThan(-1);
	expect(trim_test_build(built.code.substring(main_start))).toContain("Foo is 1!");
});
