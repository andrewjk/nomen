import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

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
});
