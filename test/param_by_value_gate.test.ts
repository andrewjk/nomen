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
// transfer requires `mv` (the callee becomes the field owner).
describe("pass-by-value struct args", () => {
	test("callee reads through the const borrow; caller unaffected, no leak", async () => {
		await run_c(
			`
mv struct Info { var markup = "" }

func fill = (Info p) {
	Console.write_line("callee sees: " + p.markup)
}

var Info a = Info()
var string pre = "pre"
a.markup = pre.copy()
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
		// The transfer row: `mv Info p` makes the callee the field owner.
		// The mv-local-write shape re-homes the struct into a local; the
		// write stays callee-local and the teardown frees the field at exit.
		const input = `
mv struct Info { var markup = "" }

func fill = (mv Info p) {
	var local = mv p
	var string w = "written"
	local.markup = w
	Console.write_line("callee sees: " + local.markup)
}

var Info a = Info()
fill(mv a)
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
		// though only the first block runs). The transfer row (`mv Pair p`)
		// owns the donor's fields: exactly one reclaim, at the return site.
		// (B1 cutover: mv structs never record, so the moved-param
		// reclaim rides the `(*p)` destroy walk instead of the `p->` record
		// frees the pre-B1 shape emitted.)
		const parsed = parse_with_imports(`
mv struct Pair { var int n = 0  var string tag = "" }
func next = (mv Pair p, out Pair) {
	var q = Pair()
	q.n = p.n + 1
	q.tag = p.tag.copy()
	return q
}
var donor = Pair()
donor.n = 5
donor.tag = "t"
var p = next(mv donor)
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
mv struct Info { var markup = "" }

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
mv struct Info { var markup = "" }
func use = (Info p) {
	Console.write_line(p.markup)
}
var Info a = Info()
use(a)
`);
		expect(parsed.errors).toEqual([]);
	});

	test("write through a bare mv param is rejected (const borrow)", () => {
		// B1 full cutover / B3: a bare mv-struct parameter is read-only —
		// mutation of the caller's storage must be spelled `ref`.
		const parsed = parse_with_imports(`
mv struct Info { var markup = "" }
func fill = (Info p) {
	p.markup = "changed"
}
var Info a = Info()
fill(a)
`);
		expect(parsed.errors.some((e) => e.message.includes("Assignment to const: p"))).toBe(true);
	});
});

// B3 transfer hole (the by-value `mv struct` param double-free): a bare
// parameter of a heap-owning mv struct aliases the caller's storage, so ANY
// ownership transfer out of it hands the destination ownership the caller's
// scope-exit destroy still reclaims. Each shape is rejected with the same
// diagnostic demanding `mv` on the parameter (or a `.copy()`).
describe("borrowed mv-struct param transfer rejection", () => {
	const ERROR = "cannot transfer ownership out of parameter";

	test("mv into a local const (the container-push staging shape)", () => {
		const parsed = parse_with_imports(`
mv struct Delimiter {
	pub var markup = ""
	pub var start = 0
	pub var length = 0
}
func set_at = (ref List<Delimiter> delimiters, int index, Delimiter value) {
	const Delimiter slot = mv value
	delimiters.push(mv slot)
}
var delimiters = List<Delimiter>()
var d = Delimiter()
d.markup = "**".to_string()
set_at(ref delimiters, 0, d)
`);
		expect(parsed.errors.some((e) => e.message.includes(ERROR))).toBe(true);
	});

	test("mv with a swap (the swap revalidates the callee's copy, not the caller's)", () => {
		const parsed = parse_with_imports(`
mv struct Info { var markup = "" }
func steal = (ref List<Info> list, Info p) {
	const Info slot = mv p swap Info()
	list.push(mv slot)
}
var list = List<Info>()
var a = Info()
a.markup = "x".to_string()
steal(ref list, a)
`);
		expect(parsed.errors.some((e) => e.message.includes(ERROR))).toBe(true);
	});

	test("by-value return of the bare param", () => {
		const parsed = parse_with_imports(`
mv struct Info { var markup = "" }
func passthrough = (Info p, out Info) {
	return p
}
var a = Info()
a.markup = "x".to_string()
var e = passthrough(a)
Console.write_line(e.markup)
`);
		expect(parsed.errors.some((e) => e.message.includes(ERROR))).toBe(true);
	});

	test("mv into an owning container parameter", () => {
		const parsed = parse_with_imports(`
mv struct Info { var markup = "" }
func consume = (ref List<Info> list, Info p) {
	list.push(mv p)
}
var list = List<Info>()
var a = Info()
a.markup = "x".to_string()
consume(ref list, a)
`);
		expect(parsed.errors.some((e) => e.message.includes(ERROR))).toBe(true);
	});

	test("assignment transfer into a local", () => {
		const parsed = parse_with_imports(`
mv struct Info { var markup = "" }
func steal = (Info p) {
	var local = Info()
	local = mv p
	Console.write_line(local.markup)
}
var a = Info()
a.markup = "x".to_string()
steal(a)
`);
		expect(parsed.errors.some((e) => e.message.includes(ERROR))).toBe(true);
	});

	test("declaring the parameter mv (with mv at the call site) is the sanctioned spelling", async () => {
		await run_c(
			`
mv struct Info { var markup = "" }
func stage = (ref List<Info> list, mv Info p) {
	list.push(mv p)
}
var list = List<Info>()
var a = Info()
a.markup = "kept".to_string()
stage(ref list, mv a)
Console.write_line(list.at_or_panic(0).markup)
`,
			"borrowed_param_transfer_mv_param",
			"kept\n",
		);
	});

	test("a scalar-field mv struct param keeps the plain by-value convention", () => {
		// No heap in the aliased bytes — reads AND by-value returns stay sound
		// without `mv` (the class_move suite's pass-by-value boundary).
		const parsed = parse_with_imports(`
mv struct Box { var int value }
func identity = (Box b, out Box) {
	return b
}
var a = Box(42)
var b = identity(a)
Console.write_line("\\{a.value},\\{b.value}")
`);
		expect(parsed.errors).toEqual([]);
	});
});
