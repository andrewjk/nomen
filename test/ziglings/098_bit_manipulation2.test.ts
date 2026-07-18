import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// 098: Bit manipulation for pangram checking.
// Uses a 32-bit integer as a bitset — one bit per letter of the alphabet.
// For each character, convert to lowercase, subtract 'a' to get bit position,
// set the bit with OR and shift. Compare final bits to 0x3FFFFFF (26 bits set).
//
// INCOMPATIBILITIES:
// - Echo doesn't have string iteration (for c of str) or string .length.
//   We use a while loop with hardcoded string length and index-based char access.
// - Echo doesn't have compound XOR/OR assignments (^=, |=). Use `a = a ^ b` form.
// - Echo doesn't have `and` keyword for logical AND. Use `&&` instead.
// - Echo doesn't have @as(), @truncate(), or std.ascii helpers. Manual char checks used.
//
// Zig output: "Is this a pangram? true!\n"

test("ziglings 098 bit manipulation2 -- errors", () => {
	const input = `
import System

func isPangram = (string str, out bool) {
    var int bits = 0
    var int i = 0
    while i < str.length; i += 1 {
        var int c = str.at(i) as int
        if c >= 65 && c <= 90 {
            c = c + 32
        }
        if c >= 97 && c <= 122 {
            var int bit = 1 << (c - 97)
            bits = bits | bit
        }
    }
    return bits == 0
}

pub func main = () {
    var bool result = isPangram("The quick brown fox jumps over the lazy dog.")
    if result {
        Console.write("Is this a pangram? true!\\n")
    } else {
        Console.write("Is this a pangram? false!\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 098 bit manipulation2 -- fixed", () => {
	const input = `
import System

func isPangram = (string str, out bool) {
    var int bits = 0
    var int i = 0
    while i < str.length; i += 1 {
        var int c = str.at(i) as int
        if c >= 65 && c <= 90 {
            c = c + 32
        }
        if c >= 97 && c <= 122 {
            var int bit = 1 << (c - 97)
            bits = bits | bit
        }
    }
    return bits == 67108863
}

pub func main = () {
    var bool result = isPangram("The quick brown fox jumps over the lazy dog.")
    if result {
        Console.write("Is this a pangram? true!\\n")
    } else {
        Console.write("Is this a pangram? false!\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 098 bit manipulation2 -- build", async () => {
	const input = `
import System

func isPangram = (string str, out bool) {
    var int bits = 0
    var int i = 0
    while i < str.length; i += 1 {
        var int c = str.at(i) as int
        if c >= 65 && c <= 90 {
            c = c + 32
        }
        if c >= 97 && c <= 122 {
            var int bit = 1 << (c - 97)
            bits = bits | bit
        }
        }
    return bits == 67108863
}

pub func main = () {
    var bool result = isPangram("The quick brown fox jumps over the lazy dog.")
    if result {
        Console.write("Is this a pangram? true!\\n")
    } else {
        Console.write("Is this a pangram? false!\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("098", built, "Is this a pangram? true!\n");
});
