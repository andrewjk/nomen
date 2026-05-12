import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 013 while 3 -- errors", () => {
	const input = `
import System

pub func main = () -> {
    var n = 1

    while n <= 20; n += 1 {
        if n % 3 == 0 { ??? }
        if n % 5 == 0 { ??? }
        Console.write("\\{n} ")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 013 while 3 -- fixed", () => {
	const input = `
import System

pub func main = () -> {
    var n = 1

    while n <= 20; n += 1 {
        if n % 3 == 0 { continue }
        if n % 5 == 0 { continue }
        Console.write("\\{n} ")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 013 while 3 -- build", async () => {
	const input = `
import System

pub func main = () -> {
    var n = 1

    while n <= 20; n += 1 {
        if n % 3 == 0 { continue }
        if n % 5 == 0 { continue }
        Console.write("\\{n} ")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });

	const expected_output = "1 2 4 7 8 11 13 14 16 17 19 ";
	await check_output_aarch64("013", built, expected_output);
});
