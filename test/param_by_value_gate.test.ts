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

// B1 full cutover: a bare parameter of an OWNING struct is a read-only const
// borrow (B3 — no implicit copy; the pbv shell convention retired with the
// declared-ownership flip). Reads go through to the caller's value; writes
// through the param are a compile error ("Assignment to const"); mutation of
// the caller's variable requires `ref` (explicit at declaration + call site);
// transfer requires `move` (the callee becomes the field owner).
describe("pass-by-value struct args", () => {
	test("callee reads through the const borrow; caller unaffected, no leak", async () => {
		await run_c(
			`
owning struct Info { var markup = "" }

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
		// The transfer row: `move Info p` makes the callee the field owner.
		// The move-local-write shape re-homes the struct into a local; the
		// write stays callee-local and the teardown frees the field at exit.
		const input = `
owning struct Info { var markup = "" }

func fill = (move Info p) {
	var local = move p
	var string w = "written"
	local.markup = w
	Console.write_line("callee sees: " + local.markup)
}

var Info a = Info()
fill(move a)
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

	test("no dead auto-free block after a return that always exits", () => {
		// A body whose last statement is a `return` cannot fall through, so
		// the function-tail auto-free must be suppressed — otherwise the C
		// epilogue re-emits the return-site frees as unreachable text after
		// the `return` (the param's field would be freed twice in the source,
		// though only the first block runs). The transfer row (`move Pair p`)
		// owns the donor's fields: exactly one reclaim, at the return site.
		// (B1 cutover: owning structs never record, so the moved-param
		// reclaim rides the `(*p)` destroy walk instead of the `p->` record
		// frees the pre-B1 shape emitted.)
		const parsed = parse_with_imports(`
owning struct Pair { var int n = 0  var string tag = "" }
func next = (move Pair p, out Pair) {
	var q = Pair()
	q.n = p.n + 1
	q.tag = p.tag
	return q
}
var donor = Pair()
donor.n = 5
donor.tag = "t"
var p = next(move donor)
Console.write_line(p.tag)
`);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", audit: true });
		const code = result.code as string;
		const fn = code.slice(code.indexOf("// Func next"), code.indexOf("// Func main"));
		const reclaims =
			fn.split("nomen_free_wrap((*p).tag.ptr);").length -
			1 +
			fn.split("nomen_free_wrap(p->tag.ptr);").length -
			1;
		expect(reclaims).toEqual(1);
	});

	test("ref arg mutates the caller's struct in place", async () => {
		// The in-place store strdups the assignment copy and records it in
		// the callee scope, whose exit drops the record — the documented
		// ref-param leak (bounded per write), so audit is off here.
		const input = `
owning struct Info { var markup = "" }

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
owning struct Info { var markup = "" }
func use = (Info p) {
	Console.write_line(p.markup)
}
var Info a = Info()
use(a)
`);
		expect(parsed.errors).toEqual([]);
	});

	test("write through a bare owning param is rejected (const borrow)", () => {
		// B1 full cutover / B3: a bare owning-struct parameter is read-only —
		// mutation of the caller's storage must be spelled `ref`.
		const parsed = parse_with_imports(`
owning struct Info { var markup = "" }
func fill = (Info p) {
	p.markup = "changed"
}
var Info a = Info()
fill(a)
`);
		expect(parsed.errors.some((e) => e.message.includes("Assignment to const: p"))).toBe(true);
	});
});
