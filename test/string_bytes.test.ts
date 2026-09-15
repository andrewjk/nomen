import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("string literal byte hazards", () => {
	test("concat with hex escape before hex digit keeps bytes", async () => {
		// Regression: the aarch64 const-fold joined raw literal text, so
		// "a\\x80" + "b" folded to "a\\x80b" and reassembled as 0x0B.
		const input = `
const s = "a\\x80" + "b"
Console.write("\\{s.length} ")
var int i = 0
while i < s.length {
	Console.write("\\{s.at(i) as int} ")
	i = i + 1
}
Console.write("\\n")
`;
		await build_and_check_output(input, "fold_escape_boundary", "3 97 128 98 \n");
	});

	test("plain concat still folds", async () => {
		const input = `
const s = "ab" + "cd"
const r = "ab" * 3
Console.write("\\{s} \\{r}\\n")
`;
		await build_and_check_output(input, "fold_plain_concat", "abcd ababab\n");
	});

	test("repeat with escapes goes through runtime concat", async () => {
		const input = `
const r = "\\x41" * 2
Console.write("\\{r} \\{r.length}\\n")
`;
		await build_and_check_output(input, "fold_escape_repeat", "AA 2\n");
	});

	test("raw multibyte chars count UTF-8 bytes", async () => {
		// Regression: string_literal_length counted every raw char as one
		// byte, so "café".length was 4 instead of 5.
		const input = `
const s = "caf\u00e9"
Console.write("\\{s.length} \\{Utf8.char_count(s)}\\n")
`;
		await build_and_check_output(input, "raw_multibyte_length", "5 4\n");
	});

	test("octal escapes count one byte", async () => {
		// Regression: "\\0123" measured 4 (pair + 3 chars) while both
		// backends store LF + "3" (2 bytes).
		const input = `
const s = "\\0123"
Console.write("\\{s.length} ")
Console.write("\\{s.at_or_panic(0) as int} \\{s.at_or_panic(1) as int}\\n")
`;
		await build_and_check_output(input, "octal_escape_length", "2 10 51\n");
	});

	test("StringBuilder preserves embedded NUL on all backends", async () => {
		// Regression: the C raw-string adapter synthesized length via
		// strlen, truncating at the first NUL.
		const input = `
var sb = StringBuilder()
sb.append_char((0x41 as char))
sb.append_char((0x0 as char))
sb.append_char((0x42 as char))
const s = sb.to_string()
Console.write("\\{s.length} ")
Console.write("\\{s.at_or_panic(0) as int} \\{s.at_or_panic(1) as int} \\{s.at_or_panic(2) as int}\\n")
var sb2 = StringBuilder()
sb2.append_string(s)
const t = sb2.to_string()
Console.write("\\{t.length} \\{t.at_or_panic(1) as int}\\n")
`;
		await build_and_check_output(input, "builder_embedded_nul", "3 65 0 66\n3 0\n");
	});

	test("hex escape before hex-digit text keeps its byte", async () => {
		// Regression (the allmark 2125-entry entity table): source escapes
		// were spliced into C verbatim, and clang consumes \x greedily —
		// "\x01AMP" decoded \x01A as ONE byte 0x1A (longer runs rejected
		// with "hex escape sequence out of range"). Hex escapes now re-encode
		// as 3-digit octal, which is self-terminating in clang and GAS.
		const input = `
const s = "\\x01AMP"
Console.write("\\{s.length} ")
var int i = 0
while i < s.length {
	Console.write("\\{s.at(i) as int} ")
	i = i + 1
}
Console.write("\\n")
`;
		await build_and_check_output(input, "hex_escape_before_text", "4 1 65 77 80 \n");
	});

	test("hex escape stays one byte before an octal digit", async () => {
		// "\x012": the octal re-encode must NOT let the trailing 2 glue on
		// (octal caps at 3 digits), so the bytes are 0x01 then '2'.
		const input = `
const s = "\\x012"
Console.write("\\{s.length} \\{s.at(0) as int} \\{s.at(1) as int}\\n")
`;
		await build_and_check_output(input, "hex_escape_octal_digit_boundary", "2 1 50\n");
	});

	test("hex runs cap at two digits; the rest is text", async () => {
		// "\x123" is byte 0x12 then '3' — the third hex digit is NOT part of
		// the escape (clang/GAS would greedily consume it; the emitters'
		// octal re-encode makes the 2-digit cap real on both backends).
		const input = `
const s = "\\x123"
Console.write("\\{s.length} \\{s.at(0) as int} \\{s.at(1) as int}\\n")
`;
		await build_and_check_output(input, "hex_escape_two_digit_cap", "2 18 51\n");
	});

	test("literals containing self are not rewritten", async () => {
		// Regression: the aarch64 backend rewrote the `self` keyword via a
		// SUBSTRING replace, so any literal merely containing "self"
		// decoded with a doubled underscore. Only the bare keyword rewrites.
		const input = `
const s = "myself"
Console.write("\\{s} ")
Console.write("\\{s == "myself"} ")
const t = "a" + "selfish"
Console.write("\\{t} \\{t.length}\\n")
`;
		await build_and_check_output(input, "self_substring_literal", "myself true aselfish 8\n");
	});
});

describe("degenerate escape rejections", () => {
	test("unknown and out-of-range escapes are check-time errors", () => {
		const expect_errors = (source: string, messages: string[]) => {
			const parsed = parse_with_imports(source);
			expect(parsed.errors.map((e) => e.message)).toEqual(messages);
		};
		expect_errors(`Console.write("\\8")`, ["unknown escape sequence '\\8'"]);
		expect_errors(`Console.write("\\9tail")`, ["unknown escape sequence '\\9'"]);
		expect_errors(`Console.write("\\x")`, [
			"incomplete hex escape '\\x' — expected 1 or 2 hex digits",
		]);
		expect_errors(`Console.write("\\777")`, ["octal escape '\\777' does not fit in one byte"]);
		expect_errors(`Console.write("\\u00e9")`, [
			"unsupported escape '\\u' — universal character names are not supported",
		]);
	});
});
