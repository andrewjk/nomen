import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 031 switch2 -- errors", () => {
	const input = `
import System

func char_for = (int c, out string) {
    return match c {
        case 1 -> "A"
        case 2 -> "B"
        case 3 -> "C"
        case 4 -> "D"
        case 5 -> "E"
        case 6 -> "F"
        case 7 -> "G"
        case 8 -> "H"
        case 9 -> "I"
        case 10 -> "J"
        case 25 -> "Y"
        case 26 -> "Z"
        else -> ???
    }
}

pub func main = () {
    const chars = Array(26, 9, 7, 42)

    for c of chars {
        Console.write(char_for(c))
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 031 switch2 -- fixed", () => {
	const input = `
import System

func char_for = (int c, out string) {
    return match c {
        case 1 -> "A"
        case 2 -> "B"
        case 3 -> "C"
        case 4 -> "D"
        case 5 -> "E"
        case 6 -> "F"
        case 7 -> "G"
        case 8 -> "H"
        case 9 -> "I"
        case 10 -> "J"
        case 25 -> "Y"
        case 26 -> "Z"
        else -> "!"
    }
}

pub func main = () {
    const chars = Array(26, 9, 7, 42)

    for c of chars {
        Console.write(char_for(c))
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 031 switch2 -- build", async () => {
	const input = `
import System

func char_for = (int c, out string) {
    return match c {
        case 1 -> "A"
        case 2 -> "B"
        case 3 -> "C"
        case 4 -> "D"
        case 5 -> "E"
        case 6 -> "F"
        case 7 -> "G"
        case 8 -> "H"
        case 9 -> "I"
        case 10 -> "J"
        case 25 -> "Y"
        case 26 -> "Z"
        else -> "!"
    }
}

pub func main = () {
    const chars = Array(26, 9, 7, 42)

    for c of chars {
        Console.write(char_for(c))
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_031", "ZIG!", true);
});
