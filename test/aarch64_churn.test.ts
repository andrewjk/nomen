import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { arch: "aarch64", audit: false } as const;

describe("aarch64 string churn then more concats", () => {
	test(
		"churn loop + concat print loop + interpolated print stays clean",
		{ timeout: 120_000 },
		async () => {
			const input = `
var string s = ""
var int i = 0
while i < 64 {
	s = s + "x"
	i += 1
}
var int j = 0
while j < 4 {
	Console.write_line("A" + j.to_string())
	j += 1
}
Console.write_line("done \\{s.length}")
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64" });
			await check_output("aarch64_churn_corruption", result, "A0\nA1\nA2\nA3\ndone 64\n", opts);
		},
	);
});
