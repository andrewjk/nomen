import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("mv value struct copy()", () => {
	test("copy is independent — writes to the copy don't escape", async () => {
		await build_and_check_output(
			`
mv struct Info { var string name = ""  var int n = 0 }
var Info a = Info()
a.name = "x"
var Info b = a.copy()
b.name = "y"
b.n = 2
Console.write_line(a.name)
Console.write_line(b.name)
Console.write_line(a.n.to_string())
Console.write_line(b.n.to_string())
`,
			"copy_independent",
			"x\ny\n0\n2\n",
		);
	});

	test("write through a bare mv param is rejected (const borrow)", () => {
		// B1 full cutover: a bare mv-struct parameter is a read-only const
		// borrow — the pbv shell convention is retired, so a callee write
		// cannot stay silently local; mutation must be spelled `ref` (the
		// next test pins its write-through visibility).
		const input = `
mv struct Info { var string name = "" }
func mutate = (Info p) {
	p.name = "changed"
	Console.write_line(p.name)
}
var Info a = Info()
a.name = "original"
mutate(a)
Console.write_line(a.name)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("Assignment to const: p"))).toBe(true);
	});

	test("ref argument: callee writes DO escape", async () => {
		// The in-place write strdups into the caller's storage and records in
		// the callee scope, whose exit drops the record — the documented
		// ref-param leak (bounded per write), so audit is off. The assertion
		// is about WRITE-THROUGH visibility, which pass-by-value must not
		// have.
		const input = `
mv struct Info { var string name = "" }
func mutate = (ref Info p) {
	p.name = "changed"
}
var Info a = Info()
a.name = "original"
mutate(ref a)
Console.write_line(a.name)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", audit: false });
		await check_output("pbv_ref_write_through", result, "changed\n", {
			audit: false,
			arch: "c",
		});
	});

	test("passthrough chain copies only the field read, and stays leak-free", async () => {
		await build_and_check_output(
			`
mv struct Pair { var int n = 0  var string tag = "" }
func build = (int n, string t, out Pair) {
	var p = Pair()
	p.n = n
	p.tag = t + "-tag"
	return p
}
func next = (Pair p, out Pair) {
	var q = Pair()
	q.n = p.n + 1
	q.tag = p.tag.copy()
	return q
}
var p = next(build(1, "one"))
Console.write_line(p.n.to_string())
Console.write_line(p.tag)
p.tag = "changed"
Console.write_line(p.tag)
`,
			"pbv_passthrough_chain",
			"2\none-tag\nchanged\n",
		);
	});

	test("copy argument is legal and equals the plain by-value form", async () => {
		await build_and_check_output(
			`
mv struct Info { var string name = "" }
func show = (Info p) {
	Console.write_line(p.name)
}
var Info a = Info()
a.name = "kept"
show(a.copy())
Console.write_line(a.name)
`,
			"pbv_copy_arg",
			"kept\nkept\n",
		);
	});
});

describe("pass-by-value ownership table", () => {
	test("mv keyword pairing rules are kept for pbv params", () => {
		// The ref/mv keyword pairing rules survive pass-by-value: a `mv`
		// keyword on a non-mv parameter is rejected (a pbv struct's byte
		// copy is sound, so transfer semantics are unnecessary), and the
		// stray keyword still invalidates the source.
		const input = `
mv struct Info { var string name = "" }
func take = (Info p) {
	Console.write_line(p.name)
}
var Info a = Info()
a.name = "moved-in"
take(mv a)
Console.write_line(a.name)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([
			expect.objectContaining({ message: expect.stringContaining("Unexpected 'mv' keyword") }),
		]);
	});

	test("fresh values (construction, call results) pass copy-free", async () => {
		await build_and_check_output(
			`
mv struct Info { var string name = "" }
func make = (string s, out Info) {
	var i = Info()
	i.name = s + "!"
	return i
}
func show = (Info p) {
	Console.write_line("got: " + p.name)
}
show(Info())
show(make("built"))
`,
			"pbv_fresh_args",
			"got: \ngot: built!\n",
		);
	});
});

describe("mv transfer of mv value structs", () => {
	test("transfer: callee owns and frees the strings, no copy at the boundary", async () => {
		await build_and_check_output(
			`
mv struct Info { var string name = "" }
func consume = (mv Info p) {
	p.name = "consumed"
	Console.write_line(p.name)
}
var Info a = Info()
a.name = "mine"
consume(mv a)
Console.write_line("done")
`,
			"pbv_move_transfer",
			"consumed\ndone\n",
		);
	});

	test("transfer param requires the mv keyword for owned variables", () => {
		const input = `
mv struct Info { var string name = "" }
func consume = (mv Info p) {
	Console.write_line(p.name)
}
var Info a = Info()
a.name = "mine"
consume(a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([
			expect.objectContaining({
				message: expect.stringContaining("Missing 'mv' keyword for mv parameter 'p'"),
			}),
		]);
	});

	test("transferred source is invalidated", () => {
		const input = `
mv struct Info { var string name = "" }
func consume = (mv Info p) {
	Console.write_line(p.name)
}
var Info a = Info()
a.name = "mine"
consume(mv a)
Console.write_line(a.name)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("used after mv"))).toBe(true);
	});

	test("moving a pbv struct out of a field requires swap", () => {
		const input = `
mv struct Info { var string name = "" }
struct Holder { var Info info = Info() }
func consume = (mv Info p) {
	Console.write_line(p.name)
}
var Holder h = Holder()
h.info.name = "inner"
consume(mv h.info)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("use 'mv ... swap <replacement>'"))).toBe(
			true,
		);
	});
});
