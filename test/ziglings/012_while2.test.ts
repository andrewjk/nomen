import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 012 while 2 -- errors", () => {
	const input = `
import System

pub func main = () {
    var n = 2

    while n < 1000; ??? {
        Console.write("\\{n} ")
    }

    Console.write("n=\\{n}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 012 while 2 -- fixed", () => {
	const input = `
import System

pub func main = () {
    var n = 2

    while n < 1000; n *= 2 {
        Console.write("\\{n} ")
    }

    Console.write("n=\\{n}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 012 while 2 -- build", async () => {
	const input = `
import System

pub func main = () {
    var n = 2

    while n < 1000; n *= 2 {
        Console.write("\\{n} ")
    }

    Console.write("n=\\{n}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);

	const expected_output = "2 4 8 16 32 64 128 256 512 n=1024";
	await build_and_check_output(input, "ziglings_012", expected_output, true);
});
