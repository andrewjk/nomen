import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// PERF_PLAN item 8: the Regex/String O(n²) accumulator shapes, pinned at the
// runtime level — results AND tracked lengths (the aarch64 fixed-array
// to_string bodies returned a garbage length half before the rewrite).

describe("accumulator shapes", () => {
	test("Regex.match returns the full first span", async () => {
		const input = `
var string m = Regex.match("[a-z]+", "1234567890 thematchedspankeepsgoing more")
Console.write(m + "\\n")
Console.write(m.length.to_string() + "\\n")
Console.write("'" + Regex.match("q", "abc") + "' " + Regex.match("q", "abc").length.to_string() + "\\n")
`;
		await build_and_check_output(input, "regex_match_span", "thematchedspankeepsgoing\n24\n'' 0\n");
	});

	test("Regex.replace_all runs (prefilter on, off, and empty matches)", async () => {
		const input = `
Console.write(Regex.replace_all("<[^>]*>", "keep<drop>keep<also drop>end", "|") + "\\n")
Console.write(Regex.replace_all("[^z]x", "no matches in here", "Q") + "E\\n")
Console.write(Regex.replace_all("x*", "abc", "-") + "\\n")
Console.write(Regex.replace_all("(>[^\\n]+)?\\n", ">head one\\nseq1\\n>head two\\nseq2\\n", "") + "|\\n")
Console.write(Regex.replace_all("a", "banana", "X") + "\\n")
`;
		await build_and_check_output(
			input,
			"regex_replace_all_runs",
			"keep|keep|end\nno matches in hereE\n-a-b-c\nseq1seq2|\nbXnXnX\n",
		);
	});

	test("String.replace_all lengths and growth", async () => {
		const input = `
var string r = "mississippi".replace_all("ss", "SS")
Console.write(r + "\\n")
Console.write(r.length.to_string() + "\\n")
Console.write("hi".replace_all("i", "iii").length.to_string() + "\\n")
Console.write("abc".replace_all("z", "long").length.to_string() + "\\n")
`;
		await build_and_check_output(input, "string_replace_all_lengths", "miSSiSSippi\n11\n4\n3\n");
	});

	test("fixed-array to_string: content and tracked length", async () => {
		const input = `
const arr = Array(1, 2, 3)
var string s = arr.to_string()
Console.write(s + "\\n")
Console.write(s.length.to_string() + "\\n")
var acc = 0
var i = 0
while i < 100; i += 1 {
	acc += arr.to_string().length
}
Console.write(acc.to_string() + "\\n")
const chars = Array('a', 'b', 'c')
var string cs = chars.to_string()
Console.write(cs + " " + cs.length.to_string() + "\\n")
`;
		await build_and_check_output(input, "array_to_string_lengths", "123\n3\n300\nabc 3\n");
	});
});
