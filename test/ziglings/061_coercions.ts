import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// 061: Zig type coercion rules.
//
// INCOMPATIBILITY: This exercise is fundamentally about Zig's type coercion
// system — coercing between pointer types (*u8 → *const u8, &letter → ?*[1]u8),
// integer widening (u8 → u16), optional wrapping, etc. Nomen does not have:
//   - Pointer type coercions (*T vs *const T)
//   - Implicit integer widening (uint8 → uint16)
//   - Optional pointer to array (?*[1]u8)
//   - Error union types
//
// This exercise cannot be meaningfully converted. The concept (type coercion)
// doesn't exist in Nomen's type system. Skipped.

test.skip("ziglings 061 coercions -- errors", () => {
	const input = `
import System

pub func main = () {
    var uint8 letter = 65
    Console.write("Letter: \\{letter}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test.skip("ziglings 061 coercions -- fixed", () => {
	const input = `
import System

pub func main = () {
    var uint8 letter = 65
    Console.write("Letter: \\{letter}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 061 coercions -- build", async () => {
	const input = `
import System

pub func main = () {
    var uint8 letter = 65
    Console.write("Letter: \\{letter}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_061", "Letter: A\n", true);
});
