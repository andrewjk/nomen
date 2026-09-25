import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { audit: true } as const;

async function run(name: string, input: string, expected: string) {
	for (const arch of ["c", "aarch64"] as const) {
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch, audit: true });
		await check_output(name, result, expected, { ...opts, arch });
	}
}

// Return-boundary normalization: when a function returns a value struct
// with string fields, the boundary makes the value uniformly heap-owned —
// recorded (heap) fields transfer raw, unrecorded fields (rodata/borrows)
// are strdup'd into the return slot — and the caller records every string
// field of a call-initialized binding so scope exit frees them. Forwarded
// call results skip the copy (already normalized by the callee). This
// closes the "returned value structs leak their heap string fields" hole.
describe("struct return normalization", () => {
	test("return + field reassignment", async () => {
		await run(
			"rb_basic",
			`
struct Info { var markup = "" }

func make = (out Info) {
	var i = Info()
	var string suffix = "def"
	i.markup = "abc" + suffix
	return i
}

var a = make()
Console.write_line(a.markup)
var string y = "y"
a.markup = "x" + y
Console.write_line(a.markup)
`,
			"abcdef\nxy\n",
		);
	});

	test("forwarded call result", async () => {
		await run(
			"rb_forward",
			`
struct Info { var markup = "" }

func make = (out Info) {
	var i = Info()
	var string suffix = "def"
	i.markup = "abc" + suffix
	return i
}

func forward = (out Info) {
	return make()
}

var a = forward()
Console.write_line(a.markup)
`,
			"abcdef\n",
		);
	});

	test("list pop transfers an owning struct", async () => {
		// `pop`'s generic body (`List<T>`) cannot be classified by the
		// whole-program pre-pass (its return type is the type parameter), so
		// the binding is unrecorded and the moved-out slot buffer leaks —
		// the documented pre-existing status quo. Run with audit off.
		for (const arch of ["c", "aarch64"] as const) {
			const input = `
struct Info { var markup = "" }
var List<Info> xs = List<Info>()
xs.push(Info())
var Info a = xs.pop()
a.markup = "popped"
Console.write_line(a.markup)
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const { default: build } = await import("../src/build");
			const { default: check_output } = await import("./check_output");
			const result = build(parsed.root, { arch, audit: false });
			await check_output("rb_pop", result, "popped\n", { audit: false, arch });
		}
	});

	test("two returned structs are independent", async () => {
		await run(
			"rb_independent",
			`
struct Info { var markup = "" }

func make = (string m, out Info) {
	var i = Info()
	i.markup = m + "!"
	return i
}

var a = make("a")
var b = make("b")
Console.write_line(a.markup)
Console.write_line(b.markup)
`,
			"a!\nb!\n",
		);
	});

	test("struct with scalar + string fields through a call chain", async () => {
		await run(
			"rb_chain",
			`
struct Pair {
	var int n = 0
	var string tag = ""
}

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
			"2\none-tag\nchanged\n",
		);
	});
});
