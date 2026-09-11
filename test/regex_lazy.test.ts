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

describe("Regex lazy quantifiers", () => {
	test(
		".+? stops at the first terminator; .+ is greedy",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("a.+?b", "aXXbYb", ref m)
Console.write("[\\{m.text}] \\{m.start} \\{m.end}\\n")
Regex.find("a.+b", "aXXbYb", ref m)
Console.write("[\\{m.text}] \\{m.start} \\{m.end}\\n")
`,
			"regex_lazy_dot",
			"[aXXb] 0 4\n[aXXbYb] 0 6\n",
		),
	);

	test(
		"HTML-comment shape <!--.+?-->",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("<!--.+?-->", "a<!-- x -->b<!-- y -->c", ref m)
Console.write("[\\{m.text}] \\{m.start} \\{m.end}\\n")
`,
			"regex_lazy_comment",
			"[<!-- x -->] 1 11\n",
		),
	);

	test(
		"lazy star and lazy optional",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("a.*?c", "abcabc", ref m)
Console.write("[\\{m.text}]\\n")
Regex.find("ab??c", "abc", ref m)
Console.write("[\\{m.text}]\\n")
Regex.find("ab?c", "abc", ref m)
Console.write("[\\{m.text}]\\n")
`,
			"regex_lazy_star_optional",
			"[abc]\n[abc]\n[abc]\n",
		),
	);

	test(
		"lazy star can match empty when the rest allows",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("a*?b", "aaab", ref m)
Console.write("[\\{m.text}] \\{m.start} \\{m.end}\\n")
Regex.find("a*?b", "bbb", ref m)
Console.write("[\\{m.text}] \\{m.start} \\{m.end}\\n")
`,
			"regex_lazy_star_empty",
			"[aaab] 0 4\n[b] 0 1\n",
		),
	);

	test(
		"lazy group quantifier (a)+? stops early",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("a+?a", "aaa", ref m)
Console.write("[\\{m.text}]\\n")
Regex.find("a+a", "aaa", ref m)
Console.write("[\\{m.text}]\\n")
var List<string> groups = List<string>()
if Regex.captures("(a+?)(a*)", "aaa", ref groups) {
	if groups.length == 3 {
		Console.write("[\\{groups.at(1)}] [\\{groups.at(2)}]\\n")
	}
}
`,
			"regex_lazy_group",
			"[aa]\n[aaa]\n[a] [aa]\n",
		),
	);
});
