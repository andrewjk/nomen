import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
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
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("042", built, "num: 5\n");
});
