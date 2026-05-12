import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 014 while 4 -- errors", () => {
	const input = `
import System

pub func main = () -> {
    var n = 1

    while true; n += 1 {
        if ??? { ??? }
    }

    Console.write("n=\\{n}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 014 while 4 -- fixed", () => {
	const input = `
import System

pub func main = () -> {
    var n = 1

    while true; n += 1 {
        if n == 4 { break }
    }

    Console.write("n=\\{n}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 014 while 4 -- build", async () => {
	const input = `
import System

pub func main = () -> {
    var n = 1

    while true; n += 1 {
        if n == 4 { break }
    }

    Console.write("n=\\{n}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });

	const expected_output = "n=4";
	await check_output_aarch64("014", built, expected_output);
});
