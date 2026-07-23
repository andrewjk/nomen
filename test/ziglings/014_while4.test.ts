import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 014 while 4 -- errors", () => {
	const input = `
import System

pub func main = () {
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

pub func main = () {
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

pub func main = () {
    var n = 1

    while true; n += 1 {
        if n == 4 { break }
    }

    Console.write("n=\\{n}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);

	const expected_output = "n=4";
	await build_and_check_output(input, "ziglings_014", expected_output, true);
});
