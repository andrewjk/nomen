import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { arch: "aarch64", audit: false } as const;

function run(source: string, name: string, expected: string) {
	return async () => {
		const parsed = parse_with_imports(source);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output(name, result, expected, opts);
	};
}

describe("Regex alternation retries into the continuation", () => {
	test(
		"a later alternative is tried when the continuation rejects an earlier one",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("(head|header)(\\\\s|$|>)", "header>", ref m)
Console.write("\\{m.found} [\\{m.text}]\\n")
`,
			"regex_alt_continuation",
			"true [header>]\n",
		),
	);

	test(
		"the winning alternative is the one the continuation agrees with",
		run(
			`
var List<string> caps = List<string>()
var bool ok = Regex.captures("(head|header)(\\\\s|$|>)", "<header>", ref caps)
var string joined = ""
for c of caps {
	joined = joined + "[" + c + "]"
}
Console.write("\\{ok} \\{joined}\\n")
`,
			"regex_alt_captures",
			"true [header>][header][>]\n",
		),
	);

	test(
		"first-match-wins still holds when the first alternative succeeds",
		run(
			`
var List<string> caps = List<string>()
var bool ok = Regex.captures("(head|header)", "header", ref caps)
var string joined = ""
for c of caps {
	joined = joined + "[" + c + "]"
}
Console.write("\\{ok} \\{joined}\\n")
`,
			"regex_alt_leftmost",
			"true [head][head]\n",
		),
	);

	test(
		"quantified and optional groups retry alternatives too",
		run(
			`
Console.write("\\{Regex.test("^(head|header)+$", "headerhead")}\\n")
Console.write("\\{Regex.test("^(head|header)?er$", "header")}\\n")
Console.write("\\{Regex.test("^(head|header)?er$", "heade")}\\n")
`,
			"regex_alt_quantified",
			"true\ntrue\nfalse\n",
		),
	);

	test(
		"nested groups and empty alternatives still behave",
		run(
			`
Console.write("\\{Regex.test("^(a|bc|)x$", "bcx")}\\n")
Console.write("\\{Regex.test("^(a|bc|)x$", "x")}\\n")
Console.write("\\{Regex.test("^((a|b)c)d$", "acd")}\\n")
`,
			"regex_alt_nested",
			"true\ntrue\ntrue\n",
		),
	);
});
