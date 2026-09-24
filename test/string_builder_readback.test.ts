import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// StringBuilder read-back/trim operations (`length`, `ends_with`,
// `truncate`, `chomp`, `take_since`) — the O(1)-amortized output-writer
// surface: an incremental renderer can append freely, then read back,
// measure a section, chomp a trailing separator, or rewind to a mark
// instead of paying quadratic `string +` accumulation.

describe("StringBuilder read-back and trim", () => {
	test("length, ends_with, chomp, truncate", async () => {
		const input = `
var StringBuilder sb = StringBuilder()
sb.seed("<p>hello</p>\\n")
Console.write_line(sb.length().to_string())
if sb.ends_with("</p>\\n") {
	Console.write_line("ew:yes")
} else {
	Console.write_line("ew:no")
}
if sb.ends_with("nope") {
	Console.write_line("ew2:yes")
} else {
	Console.write_line("ew2:no")
}
sb.chomp()
Console.write_line(sb.length().to_string())
sb.truncate(3)
Console.write_line(sb.to_string())
sb.truncate(99)
Console.write_line(sb.length().to_string())
Console.write_line("done")
`;
		await build_and_check_output(
			input,
			"string_builder_readback_trim",
			"13\new:yes\new2:no\n12\n<p>\n3\ndone\n",
		);
	});

	test("take_since extracts a section and rewinds the mark", async () => {
		const input = `
var StringBuilder sb = StringBuilder()
sb.seed("abcXYZ")
var string mid = sb.take_since(3)
Console.write_line(mid)
Console.write_line(sb.to_string())
Console.write_line(sb.length().to_string())
Console.write_line("done")
`;
		await build_and_check_output(input, "string_builder_take_since", "XYZ\nabc\n3\ndone\n");
	});
});
