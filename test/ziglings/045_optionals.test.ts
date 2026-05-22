import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise teaches the `orelse` operator for unwrapping
// nullable types with a default value. Echo uses `??` instead of `orelse`.
// Zig:  const answer: u8 = result orelse 42;
// Echo: var int answer = result ?? 42

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
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("045", built, "The Ultimate Answer: 42.\n");
});
