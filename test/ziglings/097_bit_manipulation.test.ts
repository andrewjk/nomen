import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// 097: XOR swap — swap two integer variables using only XOR.
// XOR swap takes advantage of: value XOR key = crypto, crypto XOR key = value.
// Three XORs swap the values without a temp variable.
// The fix: add the third XOR `x = x ^ y`.
//
// Zig output: "x = 0; y = 1\n"

test("ziglings 097 bit manipulation -- errors", () => {
	const input = `
import System

pub func main = () {
    var int x = 1
    var int y = 0
    x = x ^ y
    y = y ^ x
    Console.write("x = \\{x}; y = \\{y}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	// No compile error, but missing the third XOR swap step
	// Without x = x ^ y, x stays 1 instead of becoming 0
});

test("ziglings 097 bit manipulation -- fixed", () => {
	const input = `
import System

pub func main = () {
    var int x = 1
    var int y = 0
    x = x ^ y
    y = y ^ x
    x = x ^ y
    Console.write("x = \\{x}; y = \\{y}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 097 bit manipulation -- build", async () => {
	const input = `
import System

pub func main = () {
    var int x = 1
    var int y = 0
    x = x ^ y
    y = y ^ x
    x = x ^ y
    Console.write("x = \\{x}; y = \\{y}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("097", built, "x = 0; y = 1\n");
});
