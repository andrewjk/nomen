import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 095 for3 -- errors", () => {
	const input = `
import System

pub func main = () {
    for n of 1..??? {
        if n % 3 == 0 { continue }
        if n % 5 == 0 { continue }
        Console.write("\\{n} ")
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 095 for3 -- fixed", () => {
	const input = `
import System

pub func main = () {
    for n of 1..21 {
        if n % 3 == 0 { continue }
        if n % 5 == 0 { continue }
        Console.write("\\{n} ")
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 095 for3 -- build", async () => {
	const input = `
import System

pub func main = () {
    for n of 1..21 {
        if n % 3 == 0 { continue }
        if n % 5 == 0 { continue }
        Console.write("\\{n} ")
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_095", "1 2 4 7 8 11 13 14 16 17 19 \n", true);
});
