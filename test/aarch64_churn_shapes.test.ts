import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const SHAPES: { name: string; source: string; expected: string }[] = [
	{
		name: "shared counter reused across churn and print loops",
		source: `
var string s = ""
var int i = 0
while i < 96 {
	s = s + "x"
	i += 1
}
i = 0
while i < 4 {
	Console.write_line("A" + i.to_string())
	i += 1
}
Console.write_line("tail \\{s.length}!")
Console.write_line("\\{s.length}")
`,
		expected: "A0\nA1\nA2\nA3\ntail 96!\n96\n",
	},
	{
		name: "churn then concat chains inside function calls",
		source: `
func report = (string tag, int n, out string) {
	return tag + ":" + n.to_string()
}

var string s = ""
var int i = 0
while i < 80 {
	s = s + "ab"
	i += 1
}
var int j = 0
while j < 4 {
	Console.write_line(report("N", j))
	j += 1
}
Console.write_line(report("len", s.length))
`,
		expected: "N:0\nN:1\nN:2\nN:3\nlen:160\n",
	},
	{
		name: "churn feeding list of strings then print loop",
		source: `
var List<string> parts = List<string>()
var int i = 0
while i < 24 {
	parts.push("p" + i.to_string())
	i += 1
}
var string s = ""
for p of parts {
	s = s + p
}
var int j = 0
while j < 3 {
	Console.write_line("K" + j.to_string())
	j += 1
}
Console.write_line("\\{s.length}")
`,
		expected: "K0\nK1\nK2\n62\n",
	},
];

for (const shape of SHAPES) {
	test(`churn shape: ${shape.name}`, { timeout: 120_000 }, async () => {
		const parsed = parse_with_imports(shape.source);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output(
			`aarch64_churn_${shape.name.length}_${SHAPES.indexOf(shape)}`,
			result,
			shape.expected,
			{
				arch: "aarch64",
				audit: true,
			},
		);
	});
}
