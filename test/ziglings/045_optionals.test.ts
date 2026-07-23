import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise teaches the `orelse` operator for unwrapping
// nullable types with a default value. Nomen uses `??` instead of `orelse`.
// Zig:  const answer: u8 = result orelse 42;
// Nomen: var int answer = result ?? 42

test("ziglings 045 optionals -- errors", () => {
	const input = `
import System

func deepThought = (out int) {
    return null
}

pub func main = () {
    const int? result = deepThought()
    var int answer = result ?? 42
    Console.write("The Ultimate Answer: \\{answer}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 045 optionals -- fixed", () => {
	const input = `
import System

func deepThought = (out int?) {
    return null
}

pub func main = () {
    const int? result = deepThought()
    var int answer = result ?? 42
    Console.write("The Ultimate Answer: \\{answer}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 045 optionals -- build", async () => {
	const input = `
import System

func deepThought = (out int?) {
    return null
}

pub func main = () {
    const int? result = deepThought()
    var int answer = result ?? 42
    Console.write("The Ultimate Answer: \\{answer}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_045", "The Ultimate Answer: 42.\n", true);
});
