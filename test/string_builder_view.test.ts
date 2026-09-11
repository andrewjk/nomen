import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("StringBuilder view appending and seeding", () => {
	test("append_string_view takes slices without copies", async () => {
		const input = `
var string src = "hello world"
var sb = StringBuilder()
sb.append_string_view(src.slice(2, 7))
Console.write("[" + sb.to_string() + "]\\n")
var sb2 = StringBuilder()
sb2.append_string_view(src.slice(0, 5))
sb2.append_string_view(src.slice(5, 11))
Console.write("[" + sb2.to_string() + "]\\n")
var sb3 = StringBuilder()
sb3.append_string_view(src.slice(3, 3))
Console.write("[" + sb3.to_string() + "]\\n")
`;
		await build_and_check_output(
			input,
			"string_builder_append_view",
			"[llo w]\n[hello world]\n[]\n",
		);
	});

	test("seed replaces the buffer with a slice copy", async () => {
		const input = `
var string src = "hello world"
var sb = StringBuilder()
sb.seed(src.slice(0, 5))
Console.write("[" + sb.to_string() + "]\\n")
var sb2 = StringBuilder()
sb2.append_char('x')
sb2.seed(src.slice(5, 10))
Console.write("[" + sb2.to_string() + "]\\n")
var sb3 = StringBuilder()
sb3.seed(src.slice(0, 5))
sb3.append_string_view(src.slice(5, 11))
Console.write("[" + sb3.to_string() + "]\\n")
var sb4 = StringBuilder()
sb4.seed(src.slice(4, 4))
Console.write("[" + sb4.to_string() + "]\\n")
`;
		await build_and_check_output(
			input,
			"string_builder_seed",
			"[hello]\n[ worl]\n[hello world]\n[]\n",
		);
	});

	test("seeded builder is independent of its source", async () => {
		const input = `
var string src = "abc"
var sb = StringBuilder()
sb.seed(src.slice(0, 3))
src.set(0, 'X')
Console.write("[" + sb.to_string() + "]\\n")
`;
		await build_and_check_output(input, "string_builder_seed_owned", "[abc]\n");
	});
});
