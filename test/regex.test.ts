import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Companion-C allocations aren't tracked by the audit wrappers (which only
// wrap assembly-side malloc/free), so audit would report a counter imbalance.
const opts = { arch: "aarch64", audit: false } as const;

describe("Regex test", () => {
	test("literal substring matches", async () => {
		const input = `
if Regex.test("fox", "the quick brown fox") {
	Console.write("yes")
} else {
	Console.write("no")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_test_literal", result, "yes", opts);
	});

	test("no match returns false", async () => {
		const input = `
if Regex.test("cat", "the quick brown fox") {
	Console.write("yes")
} else {
	Console.write("no")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_test_none", result, "no", opts);
	});

	test("character class matches", async () => {
		const input = `
if Regex.test("[0-9]+", "abc123def") {
	Console.write("digit")
} else {
	Console.write("none")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_test_class", result, "digit", opts);
	});

	test("anchored pattern", async () => {
		const input = `
if Regex.test("^hello", "hello world") {
	Console.write("anchored")
} else {
	Console.write("no")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_test_anchor", result, "anchored", opts);
	});
});

describe("Regex match", () => {
	test("returns the first matched substring", async () => {
		const input = `
const string m = Regex.match("[0-9]+", "abc123def456")
Console.write(m)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_match_first", result, "123", opts);
	});

	test("returns empty string when no match", async () => {
		const input = `
const string m = Regex.match("xyz", "hello")
if m.length == 0 {
	Console.write("empty")
} else {
	Console.write(m)
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_match_none", result, "empty", opts);
	});

	test("matches a word pattern", async () => {
		const input = `
const string m = Regex.match("[a-z]+", "123 hello 456")
Console.write(m)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_match_word", result, "hello", opts);
	});
});

describe("Regex count", () => {
	test("counts non-overlapping matches", async () => {
		const input = `
const int c = Regex.count("ab", "ababab")
Console.write(c.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_count_basic", result, "3", opts);
	});

	test("returns 0 when no matches", async () => {
		const input = `
const int c = Regex.count("xyz", "hello world")
Console.write(c.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_count_none", result, "0", opts);
	});

	test("counts single match", async () => {
		const input = `
const int c = Regex.count("fox", "the quick brown fox")
Console.write(c.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_count_one", result, "1", opts);
	});

	test("counts with character class", async () => {
		const input = `
const int c = Regex.count("[0-9]+", "abc123def456ghi789")
Console.write(c.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_count_class", result, "3", opts);
	});

	test("counts alternation patterns", async () => {
		const input = `
const int c = Regex.count("cat|dog", "cat and dog and cat")
Console.write(c.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_count_alt", result, "3", opts);
	});

	test("counts overlapping-capable patterns", async () => {
		const input = `
const int c = Regex.count("aa", "aaaa")
Console.write(c.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_count_overlap", result, "2", opts);
	});
});

describe("Regex replace_all", () => {
	test("replaces all occurrences", async () => {
		const input = `
const string r = Regex.replace_all("o", "foo boo moo", "0")
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_replace_basic", result, "f00 b00 m00", opts);
	});

	test("returns input when no matches", async () => {
		const input = `
const string r = Regex.replace_all("xyz", "hello world", "0")
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_replace_none", result, "hello world", opts);
	});

	test("replaces with empty string", async () => {
		const input = `
const string r = Regex.replace_all(" ", "a b c", "")
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_replace_empty", result, "abc", opts);
	});

	test("replaces with multi-char replacement", async () => {
		const input = `
const string r = Regex.replace_all("fox", "the fox and the fox", "DOG")
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_replace_multi", result, "the DOG and the DOG", opts);
	});

	test("replaces character class matches", async () => {
		const input = `
const string r = Regex.replace_all("[0-9]", "a1b2c3", "X")
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_replace_class", result, "aXbXcX", opts);
	});

	test("replaces alternation patterns", async () => {
		const input = `
const string r = Regex.replace_all("cat|dog", "cat and dog", "ANIMAL")
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_replace_alt", result, "ANIMAL and ANIMAL", opts);
	});

	test("replaces consecutive matches", async () => {
		const input = `
const string r = Regex.replace_all("ab", "ababc", "X")
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_replace_consec", result, "XXc", opts);
	});

	test("empty input returns empty", async () => {
		const input = `
const string r = Regex.replace_all("x", "", "y")
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_replace_empty_input", result, "", opts);
	});
});
