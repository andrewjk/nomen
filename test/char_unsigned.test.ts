import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Char is an unsigned 8-bit code point (built_in_types.ts: signed=false).
// Loads and casts must ZERO-extend it on both backends — values >= 0x80 used
// to come back sign-extended (negative) from aarch64 element loads (`ldrsb`)
// and cast widening (`sxtb`), and from the C backend's signed `char`.
// High bytes are built via `as char`: Nomen char literals >= 0x80 are emitted
// verbatim into C sources, which rejects them (pre-existing gap).

describe("char is unsigned", () => {
	test("high-byte char casts round-trip zero-extended", async () => {
		const input = `
var char c = 233 as char
var int code = c as int
Console.write("\\{code}\\n")
`;
		await build_and_check_output(input, "char_cast_unsigned", "233\n");
	});

	test("high-byte chars compare as positive", async () => {
		const input = `
var char lo = 97 as char
var char hi = 233 as char
if hi > lo {
	Console.write("positive\\n")
} else {
	Console.write("negative\\n")
}
`;
		await build_and_check_output(input, "char_compare_unsigned", "positive\n");
	});
});
