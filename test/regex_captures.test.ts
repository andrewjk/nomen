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
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output(name, result, expected, opts);
	};
}

describe("Regex captures", () => {
	test(
		"basic group extraction",
		run(
			`
var List<string> groups = List<string>()
if Regex.captures("a(b)c", "xabc", ref groups) {
	if groups.length == 2 {
		Console.write("[\\{groups.at(0)}] [\\{groups.at(1)}]\\n")
	}
}
`,
			"regex_captures_basic",
			"[abc] [b]\n",
		),
	);

	test(
		"multiple groups",
		run(
			`
var List<string> groups = List<string>()
if Regex.captures("([a-z]+)-([0-9]+)", "id: ab-12;", ref groups) {
	if groups.length == 3 {
		Console.write("\\{groups.at(0)}|\\{groups.at(1)}|\\{groups.at(2)}\\n")
	}
}
`,
			"regex_captures_multi",
			"ab-12|ab|12\n",
		),
	);

	test(
		"alternation group reports the matched arm",
		run(
			`
var List<string> groups = List<string>()
if Regex.captures("(foo|bar)", "xbarz", ref groups) {
	if groups.length == 2 {
		Console.write("[\\{groups.at(0)}] [\\{groups.at(1)}]\\n")
	}
}
`,
			"regex_captures_alternation",
			"[bar] [bar]\n",
		),
	);

	test(
		"optional group that did not participate is empty",
		run(
			`
var List<string> groups = List<string>()
if Regex.captures("a(b)?c", "ac", ref groups) {
	if groups.length == 2 {
		Console.write("[\\{groups.at(0)}] [\\{groups.at(1)}]\\n")
	}
}
`,
			"regex_captures_unmatched",
			"[ac] []\n",
		),
	);

	test(
		"repeated group reports its last iteration",
		run(
			`
var List<string> groups = List<string>()
if Regex.captures("(a)+", "aaa", ref groups) {
	if groups.length == 2 {
		Console.write("[\\{groups.at(0)}] [\\{groups.at(1)}]\\n")
	}
}
`,
			"regex_captures_repeat_last",
			"[aaa] [a]\n",
		),
	);

	test(
		"nested groups index by open paren",
		run(
			`
var List<string> groups = List<string>()
if Regex.captures("((a)(b))c", "abc", ref groups) {
	var int i = 0
	while i < groups.length; i += 1 {
		Console.write("[\\{groups.at(i)}]")
	}
	Console.write("\\n")
}
`,
			"regex_captures_nested",
			"[abc][ab][a][b]\n",
		),
	);

	test(
		"no match returns false and leaves the list empty",
		run(
			`
var List<string> groups = List<string>()
if Regex.captures("a(b)c", "xyz", ref groups) {
	Console.write("matched\\n")
}
Console.write("\\{groups.length}\\n")
`,
			"regex_captures_no_match",
			"0\n",
		),
	);

	test(
		"group count ignores classes and escapes",
		run(
			// Pattern regex: \( [ab] (y) — the escaped '(' and the class are
			// not capture groups. ("\134" is a backslash byte; raw "\("
			// escapes aren't recognized by the aarch64 assembler's .asciz.)
			`
var List<string> groups = List<string>()
if Regex.captures("\\134([ab](y)", "(by", ref groups) {
	if groups.length == 2 {
		Console.write("[\\{groups.at(0)}] [\\{groups.at(1)}]\\n")
	}
}
`,
			"regex_captures_count_ignores_class_escape",
			"[(by] [y]\n",
		),
	);
});
