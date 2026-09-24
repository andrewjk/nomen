import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

test(
	"variant: churn helper func, then print loop, then interpolated print",
	{ timeout: 120_000 },
	async () => {
		const input = `
func churn = (int n, out string) {
	var string s = ""
	var int i = 0
	while i < n {
		s = s + "x"
		i += 1
	}
	return s
}

var string s = churn(48)
var int j = 0
while j < 3 {
	Console.write_line("A" + j.to_string())
	j += 1
}
Console.write_line("done \\{s.length}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("aarch64_churn_func", result, "A0\nA1\nA2\ndone 48\n", {
			arch: "aarch64",
			audit: true,
		});
	},
);

test(
	"variant: churn 32x2 chars + print loop + interpolated print",
	{ timeout: 120_000 },
	async () => {
		const input = `
var string s = ""
var int i = 0
while i < 32 {
	s = s + "xy"
	i += 1
}
var int j = 0
while j < 3 {
	Console.write_line("B" + j.to_string())
	j += 1
}
Console.write_line("\\{s.length}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("aarch64_churn_audit", result, "B0\nB1\nB2\n64\n", {
			arch: "aarch64",
			audit: true,
		});
	},
);
