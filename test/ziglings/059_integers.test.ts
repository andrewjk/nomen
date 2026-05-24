import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// 059: Integer literal formats — decimal, hex (0x), octal (0o), binary (0b).
// The broken code has wrong values: 0o131='Y', 0b1101000='h', 0x66='f'.
// The fix: 0o132='Z', 0b1101001='i', 0x67='g' → spells "Zig".
//
// Note: Zig prints byte arrays as strings with {s}. Echo doesn't support
// that directly, so we use a string literal instead. The exercise still
// teaches integer literal formats.

test("ziglings 059 integers -- errors", () => {
	const input = `
import System

pub func main = () {
    var uint8 z = 0o131
    var uint8 i = 0b1101000
    var uint8 g = 0x66
    Console.write("Yhf is cool.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	// The values are valid but wrong: 0o131='Y', 0b1101000='h', 0x66='f'
	// Should be: 0o132='Z', 0b1101001='i', 0x67='g'
});

test("ziglings 059 integers -- fixed", () => {
	const input = `
import System

pub func main = () {
    var uint8 z = 0o132
    var uint8 i = 0b1101001
    var uint8 g = 0x67
    Console.write("Zig is cool.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 059 integers -- build", async () => {
	const input = `
import System

pub func main = () {
    var uint8 z = 0o132
    var uint8 i = 0b1101001
    var uint8 g = 0x67
    Console.write("Zig is cool.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("059", built, "Zig is cool.\n");
});
