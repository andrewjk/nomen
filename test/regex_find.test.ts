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

describe("Regex find positions", () => {
	test(
		"reports start, end, length, and text of the first match",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("[0-9]+", "abc123def456", ref m)
Console.write("\\{m.found} \\{m.start} \\{m.end} \\{m.length} [\\{m.text}]\\n")
`,
			"regex_find_positions",
			"true 3 6 3 [123]\n",
		),
	);

	test(
		"no match: found false, everything empty",
		run(
			`
var RegexMatch m = RegexMatch()
m.text = "stale"
Regex.find("[0-9]+", "abc", ref m)
Console.write("\\{m.found} \\{m.start} \\{m.end} \\{m.length} [\\{m.text}]\\n")
`,
			"regex_find_no_match",
			"false 0 0 0 []\n",
		),
	);

	test(
		"empty match at position zero is still found",
		run(
			`
var RegexMatch m = RegexMatch()
Regex.find("x*", "ab", ref m)
Console.write("\\{m.found} \\{m.start} \\{m.end} \\{m.length}\\n")
`,
			"regex_find_empty_match",
			"true 0 0 0\n",
		),
	);

	test(
		"position bookkeeping: resume after a match",
		run(
			`
var string input = "a1bb22ccc333"
var RegexMatch m = RegexMatch()
Regex.find("[0-9]+", input, ref m)
var int total = 0
var int offset = 0
while m.found {
	total += m.length
	offset += m.end
	var string rest = input.substring(offset, input.length)
	Regex.find("[0-9]+", rest, ref m)
}
Console.write("\\{total}\\n")
`,
			"regex_find_bookkeeping",
			"6\n",
		),
	);
});
