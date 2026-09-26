import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

/** Assert one shape on the C backend (audit on): pass-by-value locality. */
async function run_c(input: string, name: string, expected: string) {
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "c", audit: true });
	await check_output(name, result, expected, { audit: true, arch: "c" });
}

// Pass-by-value for owning value structs: a function parameter of a struct
// with string fields is an OWNED copy — the call boundary materializes a
// uniformly heap-owned shell (string fields strdup\'d) and the callee frees
// its fields at scope exit. Writes through the param stay LOCAL; the
// caller\'s variable is never aliased or mutated. Mutation of the caller\'s
// variable requires `ref` (explicit at declaration + call site); transfer
// requires `move`.
describe("pass-by-value struct args", () => {
	test("callee reads its own copy; caller unaffected, no leak", async () => {
		await run_c(
			`
struct Info { var markup = "" }

func fill = (Info p) {
	Console.write_line("callee sees: " + p.markup)
}

var Info a = Info()
var string pre = "pre"
a.markup = pre
fill(a)
Console.write_line("caller sees: " + a.markup)
if a.markup == pre {
	Console.write_line("unchanged: true")
} else {
	Console.write_line("unchanged: false")
}
`,
			"pbv_locality",
			"callee sees: pre\ncaller sees: pre\nunchanged: true\n",
		);
	});

	test("callee moves the param into a local var and writes it", async () => {
		// The move-local-write shape stores the write copy RAW on aarch64
		// (value-struct fields keep borrow semantics for non-heap RHS), and
		// the record dies with the callee scope — the documented leak.
		const input = `
struct Info { var markup = "" }

func fill = (Info p) {
	var local = move p
	var string w = "written"
	local.markup = w
	Console.write_line("callee sees: " + local.markup)
}

var Info a = Info()
fill(a)
Console.write_line("caller done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const { default: build } = await import("../src/build");
		const { default: check_output } = await import("./check_output");
		const result = build(parsed.root, { arch: "c", audit: false });
		await check_output("pbv_move_local_write", result, "callee sees: written\ncaller done\n", {
			audit: false,
			arch: "c",
		});
	});

	test("ref arg mutates the caller's struct in place", async () => {
		// The in-place store strdups the assignment copy and records it in
		// the callee scope, whose exit drops the record — the documented
		// ref-param leak (bounded per write), so audit is off here.
		const input = `
struct Info { var markup = "" }

func fill = (ref Info p) {
	var string w = "via-ref"
	p.markup = w
}

var Info a = Info()
fill(ref a)
Console.write_line(a.markup)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const { default: build } = await import("../src/build");
		const { default: check_output } = await import("./check_output");
		const result = build(parsed.root, { arch: "c", audit: false });
		await check_output("pbv_ref_mutation", result, "via-ref\n", { audit: false, arch: "c" });
	});
});

describe("pass-by-value checker rules", () => {
	test("read-only callees no longer error", () => {
		const parsed = parse_with_imports(`
struct Info { var markup = "" }
func use = (Info p) {
	Console.write_line(p.markup)
}
var Info a = Info()
use(a)
`);
		expect(parsed.errors).toEqual([]);
	});
});
