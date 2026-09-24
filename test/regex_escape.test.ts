import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { arch: "aarch64", audit: false } as const;

describe("Regex escape sequences", () => {
	test("engine \\r \\n \\t escapes match control bytes", async () => {
		// "\\" in these templates is ONE backslash char in the nomen source,
		// so `\\r` is the ENGINE escape \r; `\n` is the NOMEN escape (a real
		// LF byte in the pattern/input). The first line is the FOLLOWUP
		// repro: `\r\n|\n` used to match literal "rn" and return false.
		const input = `
Console.write("\\{Regex.test("\\\\r\\\\n|\\\\n", "line1\\nline2")}\\n")
Console.write("\\{Regex.count("\\\\t", "a\\tb")}\\n")
Console.write("\\{Regex.count("[\\\\r]", "a\\rb")}\\n")
Console.write("\\{Regex.test_ci("car\\\\r", "car\\r")}\\n")
Console.write("\\{Regex.count("\\\\rz", "arz")}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_escape_control", result, "true\n1\n1\ntrue\n0\n", opts);
	});

	test("escaped control atoms keep the first-byte prefilter sound", async () => {
		// `(\r)?\n` with ENGINE escapes — the prefilter's first bytes must
		// be {CR, LF} (the real control bytes), not {'r', 'n'}.
		const input = `
Console.write("\\{Regex.count("(\\\\r)?\\\\n", "a\\rb\\nc\\nd")}\\n")
Console.write("\\{Regex.count("\\\\t+", "x\\t\\ty")}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_escape_prefilter", result, "2\n1\n", opts);
	});

	test("unsupported letter escape still matches a literal letter (no error)", async () => {
		const input = `
Console.write("\\{Regex.test("val\\\\z", "valz")}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_escape_literal_letter", result, "true\n", opts);
	});
});

describe("Regex pattern lint", () => {
	test("flags an unsupported escape in a static pattern", () => {
		const input = `
Console.write(Regex.test("val\\\\z", "valz").to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const warnings = parsed.warnings ?? [];
		expect(warnings.length).toEqual(1);
		expect(warnings[0].message).toContain("\\z");
		expect(warnings[0].start).toBeGreaterThan(0);
	});

	test("known escapes are not flagged", () => {
		const input = `
Console.write(Regex.test("\\\\d+\\\\s*x\\\\t?", "99x\\t").to_string())
Console.write(Regex.count("[\\\\w\\\\r\\\\n]", "a\\rb").to_string())
Console.write(Regex.test_ci("\\\\.", "a.b").to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		expect(parsed.warnings ?? []).toEqual([]);
	});

	test("a real control byte from a nomen escape is not flagged", async () => {
		// `\r?\n` spelled with NOMEN escapes (real CR/LF bytes in the
		// pattern) — the engine treats raw bytes as literals, nothing to
		// flag. Also covers `\\d` (engine shorthand) next to real bytes.
		const input = `
if Regex.test("\\r?\\n\\\\d", "line1\\n2") {
	Console.write("ok")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		expect(parsed.warnings ?? []).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("regex_escape_lint_clean", result, "ok", opts);
	});

	test("a dynamic pattern is not linted", () => {
		// The pattern comes from a runtime variable — not checkable. `var`
		// triggers the never-changed lint, so use `const`.
		const input = `
const string p = "val\\\\z"
Console.write(Regex.test(p, "valz").to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		expect(parsed.warnings ?? []).toEqual([]);
	});

	test("a user struct named Regex with its own test method is not linted", () => {
		const input = `
struct Regex {
	pub func test = (string pattern, string input, out bool) {
		return pattern == input
	}
}
Console.write(Regex.test("val\\\\z", "valz").to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		expect(parsed.warnings ?? []).toEqual([]);
	});
});
