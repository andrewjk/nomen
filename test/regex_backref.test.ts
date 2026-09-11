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

// A regex backreference is a BACKSLASH byte followed by a digit. In a Nomen
// string literal "\1" is an octal escape (byte 0x01), so the backslash is
// written as the octal escape "\134": "\\1341" is regex \1.

describe("Regex backreferences", () => {
	test(
		"\\1 matches the same text as group 1",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("(ab)\\1341", "xababab", ref m)
Console.write("[" + m.text + "] " + "\\{m.start} \\{m.end}\\n")
Regex.find("(ab)\\1341", "xabac", ref m)
Console.write("\\{m.found}\\n")
`,
			"regex_backref_basic",
			"[abab] 1 5\nfalse\n",
		),
	);

	test(
		"multiple backreferences in reverse order",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("(a)(b)\\1342\\1341", "abba", ref m)
Console.write("[" + m.text + "]\\n")
Regex.find("(a)(b)\\1342\\1341", "abab", ref m)
Console.write("\\{m.found}\\n")
`,
			"regex_backref_multi",
			"[abba]\nfalse\n",
		),
	);

	test(
		"alternation backreference requires the same arm",
		run(
			`
Console.write("\\{Regex.test("(a|b)\\1341", "aa")}\\n")
Console.write("\\{Regex.test("(a|b)\\1341", "bb")}\\n")
Console.write("\\{Regex.test("(a|b)\\1341", "ab")}\\n")
`,
			"regex_backref_alternation",
			"true\ntrue\nfalse\n",
		),
	);

	test(
		"unset optional group makes its backreference fail",
		run(
			`
Console.write("\\{Regex.test("(x)?y\\1341z", "yz")}\\n")
Console.write("\\{Regex.test("(x)?y\\1341z", "xyxz")}\\n")
`,
			"regex_backref_unset",
			"false\ntrue\n",
		),
	);

	test(
		"quantified backreference repeats the span",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("(a)\\1341*", "aaa", ref m)
Console.write("[" + m.text + "]\\n")
Regex.find("(ab)\\1341+", "ababab", ref m)
Console.write("[" + m.text + "]\\n")
`,
			"regex_backref_star",
			"[aaa]\n[ababab]\n",
		),
	);

	test(
		"lazy quantified backreference stops early",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("(a)\\1341+?x", "aaax", ref m)
Console.write("[" + m.text + "]\\n")
Regex.find("(a)\\1341+?x", "aaxaax", ref m)
Console.write("[" + m.text + "]\\n")
`,
			"regex_backref_lazy",
			"[aaax]\n[aax]\n",
		),
	);

	test(
		"backreference captures with positions",
		run(
			`
var List<string> groups = List<string>()
if Regex.captures("([ab])\\1341", "abb", ref groups) {
	if groups.length == 2 {
		Console.write("[" + groups.at(0) + "] [" + groups.at(1) + "]\\n")
	}
}
`,
			"regex_backref_captures",
			"[bb] [b]\n",
		),
	);
});
