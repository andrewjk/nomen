import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 030 switch -- errors", () => {
	const input = `
import System

pub func main = () {
    const chars = [26, 9, 7, 42]

    for c of chars {
        match c {
            case 1 -> Console.write("A")
            case 2 -> Console.write("B")
            case 3 -> Console.write("C")
            case 4 -> Console.write("D")
            case 5 -> Console.write("E")
            case 6 -> Console.write("F")
            case 7 -> Console.write("G")
            case 8 -> Console.write("H")
            case 9 -> Console.write("I")
            case 10 -> Console.write("J")
            case 25 -> Console.write("Y")
            case 26 -> Console.write("Z")
            else -> Console.???
        }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 030 switch -- fixed", () => {
	const input = `
import System

pub func main = () {
    const chars = [26, 9, 7, 42]

    for c of chars {
        match c {
            case 1 -> Console.write("A")
            case 2 -> Console.write("B")
            case 3 -> Console.write("C")
            case 4 -> Console.write("D")
            case 5 -> Console.write("E")
            case 6 -> Console.write("F")
            case 7 -> Console.write("G")
            case 8 -> Console.write("H")
            case 9 -> Console.write("I")
            case 10 -> Console.write("J")
            case 25 -> Console.write("Y")
            case 26 -> Console.write("Z")
            else -> Console.write("?")
        }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 030 switch -- build", async () => {
	const input = `
import System

pub func main = () {
    const chars = [26, 9, 7, 42]

    for c of chars {
        match c {
            case 1 -> Console.write("A")
            case 2 -> Console.write("B")
            case 3 -> Console.write("C")
            case 4 -> Console.write("D")
            case 5 -> Console.write("E")
            case 6 -> Console.write("F")
            case 7 -> Console.write("G")
            case 8 -> Console.write("H")
            case 9 -> Console.write("I")
            case 10 -> Console.write("J")
            case 25 -> Console.write("Y")
            case 26 -> Console.write("Z")
            else -> Console.write("?")
        }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("030", built, "ZIG?");
});
