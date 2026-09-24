import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Companion-C allocations aren't tracked by the audit wrappers (which only
// wrap assembly-side malloc/free), so audit would report a counter imbalance.
const opts = { arch: "aarch64", audit: false } as const;

async function run(name: string, input: string, expected: string) {
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output(name, result, expected, opts);
}

describe("Regex non-capturing groups", () => {
	test("(?:...) matches without allocating a group", async () => {
		await run(
			"regex_noncap_match",
			`
if Regex.test("(?:ab)+", "xababy") {
	Console.write("yes")
} else {
	Console.write("no")
}
`,
			"yes",
		);
	});

	test("non-capturing groups do not shift capture indices", async () => {
		await run(
			"regex_noncap_capture_indices",
			`
var List<string> dst = List<string>()
if Regex.captures("(?:a)(b)(c)", "abc", ref dst) {
	if dst.length == 3 {
		Console.write(dst.at(0))
		Console.write(":")
		Console.write(dst.at(1))
		Console.write(":")
		Console.write(dst.at(2))
	}
}
`,
			"abc:b:c",
		);
	});

	test("quantified non-capturing group", async () => {
		await run(
			"regex_noncap_quantified",
			`
Console.write(Regex.match("(?:ab)+", "zzababzz"))
`,
			"abab",
		);
	});

	test("non-capturing group with alternation", async () => {
		await run(
			"regex_noncap_alt",
			`
const string r = Regex.replace_all("(?:cat|dog)", "cat and dog", "X")
Console.write(r)
`,
			"X and X",
		);
	});

	test("counted repetition of a non-capturing group", async () => {
		await run(
			"regex_noncap_counted",
			`
Console.write(Regex.match("(?:ab){2,3}", "zzabababzz"))
`,
			"ababab",
		);
	});
});

describe("Regex counted repetition", () => {
	test("{n} exact count", async () => {
		await run(
			"regex_counted_exact",
			`
Console.write(Regex.match("[0-9]{3}", "a12345"))
`,
			"123",
		);
	});

	test("{n,} minimum count", async () => {
		await run(
			"regex_counted_min",
			`
Console.write(Regex.match("a{2,}", "xaaaa"))
`,
			"aaaa",
		);
	});

	test("{n,m} bounded greedy takes the longest", async () => {
		await run(
			"regex_counted_range",
			`
Console.write(Regex.match("[0-9]{2,3}", "a12345"))
`,
			"123",
		);
	});

	test("{n,m}? lazy takes the shortest", async () => {
		await run(
			"regex_counted_lazy",
			`
Console.write(Regex.match("[0-9]{2,3}?", "a12345"))
`,
			"12",
		);
	});

	test("{0,n} is nullable for the first-byte prefilter", async () => {
		await run(
			"regex_counted_nullable",
			`
Console.write(Regex.count("a{0,2}b", "b ab aab").to_string())
`,
			"3",
		);
	});

	test("counted repetition that cannot be satisfied fails", async () => {
		await run(
			"regex_counted_fail",
			`
if Regex.test("a{5}", "aaaa") {
	Console.write("yes")
} else {
	Console.write("no")
}
`,
			"no",
		);
	});

	test("autolink scheme shape [a-z][a-z0-9+.-]{1,31}", async () => {
		await run(
			"regex_counted_scheme",
			`
Console.write(Regex.match("[a-z][a-z0-9+.-]{1,31}", "scheme+ext"))
`,
			"scheme+ext",
		);
	});

	test("{n} of a class rejects a longer run at exactly n", async () => {
		await run(
			"regex_counted_exact_stop",
			`
Console.write(Regex.match("[a-z]{2}", "abcdef"))
`,
			"ab",
		);
	});
});

describe("Regex lookbehind and lookahead", () => {
	test("positive lookbehind", async () => {
		await run(
			"regex_lookbehind_pos",
			`
Console.write(Regex.count("(?<=a)b", "ab ab cb").to_string())
`,
			"2",
		);
	});

	test("negative lookbehind", async () => {
		await run(
			"regex_lookbehind_neg",
			`
Console.write(Regex.replace_all("(?<!a)b", "ab cb", "X"))
`,
			"ab cX",
		);
	});

	test("positive lookahead", async () => {
		await run(
			"regex_lookahead_pos",
			`
if Regex.test("foo(?=bar)", "foobar") {
	Console.write("yes")
} else {
	Console.write("no")
}
`,
			"yes",
		);
	});

	test("negative lookahead", async () => {
		await run(
			"regex_lookahead_neg",
			`
if Regex.test("foo(?!bar)", "foobaz") {
	Console.write("yes")
} else {
	Console.write("no")
}
`,
			"yes",
		);
	});

	test("split on unescaped pipes (the table-split idiom)", async () => {
		await run(
			"regex_lookbehind_split",
			`
const string r = Regex.replace_all("(?<!-)[|]", "a|b|-|c", "/")
Console.write(r)
`,
			"a/b/-|c",
		);
	});
});
