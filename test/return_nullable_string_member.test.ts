import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Returning a struct with a nullable string member from a free function used
// to SIGSEGV: the return-boundary normalization strdup'd every string field,
// including a NULL `string?` field — `strdup(NULL)` crashed (C) / fabricated
// a non-null empty string. Duplicating a null pair now yields null.

describe("returning a struct with a nullable string member", () => {
	test("null and non-null nullable string members round-trip", async () => {
		const input = `
struct Rule {
	var name = ""
	var string? pattern = null
}

func make_rule = (string name, string? pattern, out Rule) {
	var r = Rule()
	r.name = name
	r.pattern = pattern
	return r
}

var r = make_rule("cite", null)
Console.write("name=\\{r.name}\\n")
if r.pattern == null { Console.write("pattern null\\n") } else { Console.write("PATTERN BUG\\n") }

var s = make_rule("href", "http")
Console.write("name=\\{s.name}\\n")
if s.pattern != null { Console.write("pattern=\\{s.pattern}\\n") }
`;
		await build_and_check_output(
			input,
			"return_nullable_string_member",
			"name=cite\npattern null\nname=href\npattern=http\n",
		);
	});
});
