import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Companion-C allocations aren't tracked by the audit wrappers (which only
// wrap assembly-side malloc/free), so audit would report a counter imbalance.
const opts = { arch: "aarch64", audit: false } as const;

function run(source: string, name: string, expected: string) {
	return async () => {
		const parsed = parse_with_imports(source);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: false });
		await check_output(name, result, expected, opts);
	};
}

// A regex shorthand is a BACKSLASH byte followed by a letter. In a Nomen
// string literal that's the escaped-backslash pair: "\\d" (\\\\ in these TS
// templates) — "\d" alone is an unknown escape both languages reject.

describe("Regex class shorthands", () => {
	test(
		"\\d matches ASCII digits",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("\\\\d+", "abc 123 def", ref m)
Console.write("[" + m.text + "] " + "\\{m.start} \\{m.end}\\n")
Console.write("\\{Regex.test("\\\\d", "x")}\\n")
`,
			"regex_shorthand_digit",
			"[123] 4 7\nfalse\n",
		),
	);

	test(
		"\\w matches word characters",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("\\\\w+", "  foo_bar1!  ", ref m)
Console.write("[" + m.text + "]\\n")
Console.write("\\{Regex.test("\\\\w", "!")}\\n")
Console.write("\\{Regex.test("\\\\w", "_")}\\n")
`,
			"regex_shorthand_word",
			"[foo_bar1]\nfalse\ntrue\n",
		),
	);

	test(
		"\\s matches ASCII whitespace",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("\\\\s+", "a\\t\\nb c", ref m)
Console.write("[" + m.text + "]\\n")
Console.write("\\{Regex.test("\\\\s", "x")}\\n")
`,
			"regex_shorthand_space",
			"[\t\n]\nfalse\n",
		),
	);

	test(
		"complement shorthands invert the set",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("\\\\D+", "12ab34", ref m)
Console.write("[" + m.text + "]\\n")
Regex.find("\\\\W+", "ab.-!cd", ref m)
Console.write("[" + m.text + "]\\n")
Regex.find("\\\\S+", "  xy ", ref m)
Console.write("[" + m.text + "]\\n")
`,
			"regex_shorthand_complements",
			"[ab]\n[.-!]\n[xy]\n",
		),
	);

	test(
		"shorthands work inside classes",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("[\\\\d_]+", "a 12_4 b", ref m)
Console.write("[" + m.text + "]\\n")
Console.write("\\{Regex.test("[\\\\s]", "x")}\\n")
`,
			"regex_shorthand_in_class",
			"[12_4]\nfalse\n",
		),
	);

	test(
		"quantified shorthands with the prefilter",
		run(
			`
Console.write("\\{Regex.count("\\\\d", "a1b22c333")}\\n")
Console.write(Regex.replace_all("\\\\d", "a1b22c333", "N"))
Console.write("\\n")
`,
			"regex_shorthand_count_replace",
			"6\naNbNNcNNN\n",
		),
	);

	test(
		"case-insensitive folding leaves shorthands intact",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find_ci("\\\\d+", "ab:77", ref m)
Console.write("[" + m.text + "]\\n")
Console.write("\\{Regex.test_ci("\\\\w", "!")}\\n")
`,
			"regex_shorthand_ci",
			"[77]\nfalse\n",
		),
	);
});
