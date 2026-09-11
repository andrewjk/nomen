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

describe("Regex case-insensitive", () => {
	test(
		"test_ci ignores case; test does not",
		run(
			`
Console.write("\\{Regex.test("hello", "HeLLo world")}\\n")
Console.write("\\{Regex.test_ci("hello", "HeLLo world")}\\n")
Console.write("\\{Regex.test_ci("world", "HeLLo world")}\\n")
Console.write("\\{Regex.test_ci("xyz", "HeLLo world")}\\n")
`,
			"regex_ci_test",
			"false\ntrue\ntrue\nfalse\n",
		),
	);

	test(
		"match_ci and find_ci report case-preserving text",
		run(
			`
var string m = Regex.match_ci("[a-z]+", "ABC def")
Console.write("[" + m + "]\\n")
var RegexMatch f = RegexMatch()
Regex.find_ci("abc", "XAbC", ref f)
Console.write("[" + f.text + "] \\{f.start} \\{f.end}\\n")
`,
			"regex_ci_match_find",
			"[ABC]\n[AbC] 1 4\n",
		),
	);

	test(
		"captures_ci keeps group structure",
		run(
			`
var List<string> groups = List<string>()
if Regex.captures_ci("(hello)-([a-z]+)", "say HELLO-WORLD!", ref groups) {
	if groups.length == 3 {
		Console.write("[\\{groups.at(0)}] [\\{groups.at(1)}] [\\{groups.at(2)}]\\n")
	}
}
`,
			"regex_ci_captures",
			"[HELLO-WORLD] [HELLO] [WORLD]\n",
		),
	);

	test(
		"replace_all_ci replaces every case variant",
		run(
			`
Console.write(Regex.replace_all_ci("foo", "FOO foo Fo f", "bar"))
Console.write("\\n")
`,
			"regex_ci_replace",
			"bar bar Fo f\n",
		),
	);

	test(
		"classes fold: ranges mirror, negation unaffected",
		run(
			`
Console.write("\\{Regex.test_ci("[a-c]+", "ABC")}\\n")
Console.write("\\{Regex.test_ci("[^a]+", "AAA")}\\n")
Console.write("\\{Regex.test_ci("[^a]+", "bBb")}\\n")
`,
			"regex_ci_class",
			"true\nfalse\ntrue\n",
		),
	);

	test(
		"escaped punctuation is structure, escaped letters fold",
		run(
			// "\134" is a backslash byte: pattern is \(x\) — literal parens —
			// and a\qz — an escaped letter folds to [qQ]. ("\134" dodges the
			// aarch64 assembler's .asciz, which lacks \( and \q escapes.)
			`
Console.write("\\{Regex.test_ci("\\134(x\\134)", "(X)")}\\n")
Console.write("\\{Regex.test_ci("\\134(x\\134)", "(x)")}\\n")
Console.write("\\{Regex.test_ci("a\\134qz", "AQZ")}\\n")
`,
			"regex_ci_escape",
			"true\ntrue\ntrue\n",
		),
	);
});
