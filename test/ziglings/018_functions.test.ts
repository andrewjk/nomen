import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
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
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("018", built, "Answer to the Ultimate Question: 42");
});
