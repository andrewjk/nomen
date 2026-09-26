import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("owning value struct copy()", () => {
	test("copy is independent — writes to the copy don't escape", async () => {
		await build_and_check_output(
			`
struct Info { var string name = ""  var int n = 0 }
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

	test("pbv argument: callee writes don't escape, no leak", async () => {
		await build_and_check_output(
			`
struct Info { var string name = "" }
func mutate = (Info p) {
	p.name = "changed"
	Console.write_line(p.name)
}
var Info a = Info()
a.name = "original"
mutate(a)
Console.write_line(a.name)
`,
			"pbv_write_locality",
			"changed\noriginal\n",
		);
	});

	test("ref argument: callee writes DO escape", async () => {
		// The in-place write strdups into the caller's storage and records in
		// the callee scope, whose exit drops the record — the documented
		// ref-param leak (bounded per write), so audit is off. The assertion
		// is about WRITE-THROUGH visibility, which pass-by-value must not
		// have.
		const input = `
struct Info { var string name = "" }
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
		const { default: build } = await import("../src/build");
		const { default: check_output } = await import("./check_output");
		const result = build(parsed.root, { arch: "c", audit: false });
		await check_output("pbv_ref_write_through", result, "changed\n", {
			audit: false,
			arch: "c",
		});
	});

	test("passthrough chain stays copy-free and leak-free", async () => {
		await build_and_check_output(
			`
struct Pair { var int n = 0  var string tag = "" }
func build = (int n, string t, out Pair) {
	var p = Pair()
	p.n = n
	p.tag = t + "-tag"
	return p
}
func next = (Pair p, out Pair) {
	var q = Pair()
	q.n = p.n + 1
	q.tag = p.tag
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
struct Info { var string name = "" }
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
	test("move keyword pairing rules are kept for pbv params", () => {
		// The ref/move keyword pairing rules survive pass-by-value: a `move`
		// keyword on a non-move parameter is rejected (a pbv struct's byte
		// copy is sound, so transfer semantics are unnecessary), and the
		// stray keyword still invalidates the source.
		const input = `
struct Info { var string name = "" }
func take = (Info p) {
	Console.write_line(p.name)
}
var Info a = Info()
a.name = "moved-in"
take(move a)
Console.write_line(a.name)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([
			expect.objectContaining({ message: expect.stringContaining("Unexpected 'move' keyword") }),
		]);
	});

	test("fresh values (construction, call results) pass copy-free", async () => {
		await build_and_check_output(
			`
struct Info { var string name = "" }
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
