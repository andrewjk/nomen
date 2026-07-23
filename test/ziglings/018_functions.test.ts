import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 018 functions -- errors", () => {
	const input = `
import System

pub func main = () {
    const int answer = deepThought()
    Console.write("Answer to the Ultimate Question: \\{answer}")
}

??? deepThought() ??? {
    return 42
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 018 functions -- fixed", () => {
	const input = `
import System

pub func main = () {
    const int answer = deepThought()
    Console.write("Answer to the Ultimate Question: \\{answer}")
}

func deepThought = (out int) {
    return 42
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 018 functions -- build", async () => {
	const input = `
import System

pub func main = () {
    const int answer = deepThought()
    Console.write("Answer to the Ultimate Question: \\{answer}")
}

func deepThought = (out int) {
    return 42
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_018", "Answer to the Ultimate Question: 42", true);
});
