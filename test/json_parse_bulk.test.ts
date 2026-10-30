import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// PERF_PLAN item 17 (minor batch): the JSON string scanner appended one byte
// per loop iteration (`sb.append_char(s.at(i))` — a builder capacity check +
// length bump per byte). It now scans to the next `"`/`\` and appends the
// whole plain run as ONE `append_string_view` (a bulk memcpy), then handles
// the escape byte. `json_parse_number`'s digit copy got the same treatment
// (its scan already found the run; only the copy loop remained). Pinned at
// the runtime level (long runs, every escape case, number runs — both
// backends, audit on) and at the emitted-code level (bulk appends only).

function build_aarch64(source: string): string {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "aarch64", audit: false }).code;
}

function build_c(source: string): string {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "c", audit: false }).code;
}

const PROGRAM = `
var t1 = JsonTree()
var n1 = Json.parse("\\"01234567890123456789012345678901234567890123456789\\"", ref t1)
var v1 = Json.stringify(ref t1, n1)
Console.write("len=\\{v1.length} first=\\{v1.at_or_panic(1)} last=\\{v1.at_or_panic(50)}\\n")
var t2 = JsonTree()
var n2 = Json.parse("\\"a\\\\tb\\\\\\"c\\\\\\\\d\\\\q\\"", ref t2)
var v2 = Json.stringify(ref t2, n2)
var i = 1
while i < v2.length - 1; i += 1 {
	Console.write("\\{v2.at_or_panic(i) as int} ")
}
Console.write("\\n")
var t3 = JsonTree()
var n3 = Json.parse("[-12.5e+3, 7]", ref t3)
Console.write(Json.stringify(ref t3, n3))
Console.write("\\n")
`;

describe("JSON string/number parse bulk appends", () => {
	test("plain runs, every escape case, and number runs round-trip", async () => {
		// 50 plain bytes → one bulk append (stringify adds the quotes: 52);
		// escapes decode to a<TAB>b"c\d, and the unknown `\q` keeps `q`
		// verbatim; the number run is copied in one append.
		await build_and_check_output(
			PROGRAM,
			"json_parse_bulk",
			"len=52 first=0 last=9\n97 9 98 34 99 92 100 113 \n[-12.5e+3,7]\n",
		);
	});

	test("the aarch64 scanner bulk-appends runs instead of per-byte chars", () => {
		const code = build_aarch64(PROGRAM);
		// json_parse_string and json_parse_number both bulk-append; the only
		// single-byte append left in the string scanner is the decoded `\"`
		// escape (one byte by definition).
		expect(code).toContain("bl StringBuilder_append_string_view");
		const start = code.indexOf("json_parse_string:");
		const end = code.indexOf("json_parse_number:", start);
		const body = code.slice(start, end > start ? end : undefined);
		expect(body).toContain("bl StringBuilder_append_string_view");
		// The only single-byte appends left are the escape decode's (`\"` and
		// the unknown-escape fallback) — never the plain-run scan.
		expect((body.match(/bl StringBuilder_append_char/g) ?? []).length).toBeLessThanOrEqual(2);
	});

	test("the C scanner bulk-appends runs instead of per-byte chars", () => {
		const code = build_c(PROGRAM);
		const start = code.indexOf("long json_parse_string");
		const end = code.indexOf("// Func json_parse_number", start);
		const body = code.slice(start, end > start ? end : undefined);
		expect(body).toContain("StringBuilder_append_string_view");
		// The only single-byte appends left are the escape decode's (`\"` and
		// the unknown-escape fallback) — never the plain-run scan.
		expect((body.match(/StringBuilder_append_char/g) ?? []).length).toBeLessThanOrEqual(2);
		const num_start = code.indexOf("long json_parse_number", start);
		const num_end = code.indexOf("// Func json_parse_literal", num_start);
		const num_body = code.slice(num_start, num_end > num_start ? num_end : undefined);
		expect(num_body).toContain("StringBuilder_append_string_view");
		expect(num_body).not.toContain("StringBuilder_append_char");
	});
});
