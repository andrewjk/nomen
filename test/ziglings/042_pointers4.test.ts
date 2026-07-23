import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 042 pointers4 -- errors", () => {
	const input = `
import System

pub func main = () {
    var int num = 1

    makeFive(ref num)
    Console.write("num: \\{num}\\n")
}

func makeFive = (ref int x) {
    ??? = 5
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 042 pointers4 -- fixed", () => {
	const input = `
import System

pub func main = () {
    var int num = 1

    makeFive(ref num)
    Console.write("num: \\{num}\\n")
}

func makeFive = (ref int x) {
    x = 5
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 042 pointers4 -- build", async () => {
	const input = `
import System

pub func main = () {
    var int num = 1

    makeFive(ref num)
    Console.write("num: \\{num}\\n")
}

func makeFive = (ref int x) {
    x = 5
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_042", "num: 5\n", true);
});
