import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build.ts";
import build_js from "../src/build_js/build_js.ts";
import { get_library } from "../src/lib.ts";
import type FunctionNode from "../src/nodes/FunctionNode.ts";
import parse from "../src/parse.ts";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function parse_src(source: string, options?: { arch?: string; platform?: string }) {
	return parse(`import System\n${source}`, system, undefined, {
		allow_internal: true,
		...options,
	});
}

/** Parse, build JS, run under node, return trimmed stdout lines. */
function run_js(source: string): string[] {
	const parsed = parse_src(source);
	expect(parsed.errors).toEqual([]);
	const js = build_js(parsed.root, { target: "node" });
	expect(js.errors ?? []).toEqual([]);
	const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "comptime-type-")), "t.mjs");
	fs.writeFileSync(outfile, js.code);
	return execFileSync(process.execPath, [outfile], { encoding: "utf8" }).trim().split("\n");
}

// ---------------------------------------------------------------------------
// Declaration + specialization
// ---------------------------------------------------------------------------

test("type T over a builtin: T() is the zero value", () => {
	const lines = run_js(`
		func zero = (type T, out T) {
			var T x = T()
			return x
		}
		pub func main = () {
			Console.write_line("\\{zero(int)}")
			Console.write_line("\\{zero(bool)}")
		}
	`);
	expect(lines).toEqual(["0", "false"]);
});

test("type T over a struct: the constructor runs, the signature drops the param", () => {
	const lines = run_js(`
		struct Point {
			var int x = 0
			var int y = 0
		}
		func zero = (type T, out T) {
			var T x = T()
			return x
		}
		pub func main = () {
			var p = zero(Point)
			Console.write_line("\\{p.x},\\{p.y}")
		}
	`);
	expect(lines).toEqual(["0,0"]);
});

test("the T: type spelling parses to the same thing", () => {
	const lines = run_js(`
		func zero_a = (type T, out T) {
			var T x = T()
			return x
		}
		func zero_b = (T: type, out T) {
			var T x = T()
			return x
		}
		pub func main = () {
			Console.write_line("\\{zero_a(int)} \\{zero_b(int)}")
		}
	`);
	expect(lines).toEqual(["0 0"]);
});

test("specializations memoize: one clone per distinct type", () => {
	const parsed = parse_src(`
		struct Point {
			var int x = 0
		}
		func zero = (type T, out T) {
			var T x = T()
			return x
		}
		pub func main = () {
			var a = zero(Point)
			var b = zero(Point)
			var c = zero(int)
		}
	`);
	expect(parsed.errors).toEqual([]);
	const clones = (parsed.root.statements ?? [])
		.map((s) => s as FunctionNode)
		.filter((f) => f.node_type === "func" && (f.name === "zero_Point" || f.name === "zero_int"));
	expect(clones.map((f) => f.name).sort()).toEqual(["zero_Point", "zero_int"]);
	// The erased signature: no `type` parameter survives on the clone.
	expect(clones.find((f) => f.name === "zero_Point")?.params ?? []).toHaveLength(0);
});

test("an unspecialized type-param function defers like any generic", () => {
	const parsed = parse_src(`
		func never_called = (type T, out int) {
			var T x = T()
			return 0
		}
	`);
	expect(parsed.errors).toEqual([]);
});

test("a type param composes with runtime params", () => {
	const lines = run_js(`
		struct Point {
			var int x
			var int y
		}
		func scaled = (type T, T base, int k, out T) {
			var out_v = base
			#for field of META.info(T).fields {
				field.set(out_v, field.get(base) * k)
			}
			return out_v
		}
		pub func main = () {
			var p = scaled(Point, Point(2, 5), 3)
			Console.write_line("\\{p.x},\\{p.y}")
		}
	`);
	expect(lines).toEqual(["6,15"]);
});

// ---------------------------------------------------------------------------
// Composition with reflection (the point of stage 4)
// ---------------------------------------------------------------------------

test("META.info(T) + #for compose inside a type-param function", () => {
	const lines = run_js(`
		mv struct Sample {
			var int count = 0
			var string label = ""
		}
		func sample_value = (type T, mv out T) {
			var T x = T()
			return x
		}
		func describe = (type T, out string) {
			var s = META.info(T).name + "("
			var first = true
			#for field of META.info(T).fields {
				if !first {
					s = s + ", "
				}
				first = false
				s = s + field.name + "=" + field.get(sample_value(T)).to_string()
			}
			s = s + ")"
			return s
		}
		pub func main = () {
			Console.write_line(describe(Sample))
		}
	`);
	expect(lines).toEqual(["Sample(count=0, label=)"]);
});

test("comptime dispatch on the bound type folds — the dead arm is never checked", () => {
	const lines = run_js(`
		func probe = (type T, out string) {
			if META.is_struct(T) {
				// Dead for every argument this program passes — a call to a
				// function that does not exist must never surface.
				return struct_path(T)
			} else {
				return "builtin:" + META.name(T)
			}
		}
		pub func main = () {
			Console.write_line(probe(int))
		}
	`);
	expect(lines).toEqual(["builtin:int"]);
});

test("forwarding: a type param passes through two generic levels", () => {
	const lines = run_js(`
		func inner = (type U, out string) {
			return META.info(U).name
		}
		func outer<T> = (T value, out string) {
			return inner(T) + " <- " + META.info(T).name
		}
		pub func main = () {
			Console.write_line(outer(1))
		}
	`);
	expect(lines).toEqual(["int <- int"]);
});

test("forwarding: a generic struct method passes its own parameter", () => {
	const lines = run_js(`
		func forwarder = (type T, out string) {
			return META.info(T).name
		}
		struct Holder<T> {
			var T value
			pub func forward = (self, out string) {
				return forwarder(T)
			}
		}
		pub func main = () {
			var h = Holder<int>(5)
			Console.write_line(h.forward())
		}
	`);
	expect(lines).toEqual(["int"]);
});

test("forwarding: through a custom #init of a generic struct", () => {
	const lines = run_js(`
		func label_of = (type T, out string) {
			return "has:" + META.info(T).name
		}
		struct Wrap<T> {
			var T item
			pub func #init = (self, T item) {
				self.item = item
			}
			pub func describe = (self, out string) {
				return label_of(T)
			}
		}
		pub func main = () {
			var w = Wrap<int>(7)
			Console.write_line(w.describe())
		}
	`);
	expect(lines).toEqual(["has:int"]);
});

test("forwarding: an instantiation spelling rides the struct parameter", () => {
	const lines = run_js(`
		func size_of = (type T, out string) {
			return META.info(T).name
		}
		struct Box<T> {
			var T item
			pub func probe = (self, out string) {
				return size_of(List<T>)
			}
		}
		pub func main = () {
			var b = Box<int>(1)
			Console.write_line(b.probe())
		}
	`);
	expect(lines).toEqual(["List_int"]);
});

test("a type-param function specializes over a concrete struct with containers", () => {
	const lines = run_js(`
		mv struct Holder {
			var items = StableList<int>()
			var n = 0
		}
		func describe = (type T, out string) {
			return META.info(T).name
		}
		pub func main = () {
			Console.write_line(describe(Holder))
		}
	`);
	expect(lines).toEqual(["Holder"]);
});

// ---------------------------------------------------------------------------
// Generic instantiations as type arguments
// ---------------------------------------------------------------------------

test("a generic instantiation names the mono as a type argument", () => {
	const lines = run_js(`
		func name_of = (type T, out string) {
			return META.info(T).name
		}
		pub func main = () {
			var l = List<int>()
			Console.write_line(name_of(List<int>))
			Console.write_line(name_of(Map<string, int>))
		}
	`);
	expect(lines).toEqual(["List_int", "Map_string_int"]);
});

test("a nested instantiation flattens in a type argument", () => {
	const lines = run_js(`
		func name_of = (type T, out string) {
			return META.info(T).name
		}
		pub func main = () {
			var l = List<List<int>>()
			Console.write_line(name_of(List<List<int>>))
		}
	`);
	expect(lines).toEqual(["List_List_int"]);
});

test("an instantiation argument materializes the mono without another use site", () => {
	const parsed = parse_src(`
		struct Wrapper<T> {
			var T item
		}
		func name_of = (type T, out string) {
			return META.info(T).name
		}
		pub func main = () {
			Console.write_line(name_of(Wrapper<float>))
		}
	`);
	expect(parsed.errors).toEqual([]);
	const monos = (parsed.root.statements ?? []).map((s) => (s as { name?: string }).name);
	expect(monos).toContain("Wrapper_float");
	expect(monos).toContain("name_of_Wrapper_float");
});

test("instantiation type arguments compose with #for reflection", () => {
	const lines = run_js(`
		func describe = (type T, out string) {
			var s = META.info(T).name + "("
			var first = true
			#for field of META.info(T).fields {
				if !first {
					s = s + ", "
				}
				first = false
				s = s + field.name
			}
			return s + ")"
		}
		pub func main = () {
			Console.write_line(describe(List<int>))
		}
	`);
	expect(lines).toEqual(["List_int(length, items)"]);
});

test("lowercase operands keep the comparison reading", () => {
	const lines = run_js(`
		func both = (bool a, bool b, out string) {
			var s = ""
			if a {
				s = s + "1"
			} else {
				s = s + "0"
			}
			if b {
				s = s + "1"
			} else {
				s = s + "0"
			}
			return s
		}
		pub func main = () {
			var x = 1
			var y = 2
			var z = 3
			Console.write_line(both(x < y, z > y))
			Console.write_line(both(y < x, z < y))
		}
	`);
	expect(lines).toEqual(["11", "00"]);
});

test("a non-generic type takes no type arguments", () => {
	const parsed = parse_src(`
		struct Point {
			var int x = 0
		}
		func f = (type T, out int) {
			return 0
		}
		pub func main = () {
			f(Point<int>)
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("'Point' is not generic"))).toBe(true);
});

test("an instantiation arity mismatch errors at the call", () => {
	const parsed = parse_src(`
		func f = (type T, out int) {
			return 0
		}
		pub func main = () {
			f(List<int, string>)
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("takes 1 type argument(s), got 2"))).toBe(
		true,
	);
});

// ---------------------------------------------------------------------------
// Default construction — T() over a struct whose fields lack defaults
// ---------------------------------------------------------------------------

test("T() zero-constructs a struct whose fields lack defaults", () => {
	const lines = run_js(`
		struct Pair {
			var int a
			var int b
		}
		func zero = (type T, out T) {
			var T x = T()
			return x
		}
		pub func main = () {
			var p = zero(Pair)
			Console.write_line("\\{p.a},\\{p.b}")
		}
	`);
	expect(lines).toEqual(["0,0"]);
});

test("T() default construction recurses into nested structs", () => {
	const lines = run_js(`
		struct Inner {
			var int a
			var int b
		}
		struct Outer {
			var Inner inner
			var int n
		}
		func zero = (type T, out T) {
			var T x = T()
			return x
		}
		pub func main = () {
			var o = zero(Outer)
			Console.write_line("\\{o.n},\\{o.inner.a},\\{o.inner.b}")
		}
	`);
	expect(lines).toEqual(["0,0,0"]);
});

test("T() zero-construction works inside a generic struct method", () => {
	const lines = run_js(`
		struct Pair {
			var int a
			var int b
		}
		struct Maker<T> {
			var int n = 0
			pub func make = (self, out T) {
				return T()
			}
		}
		pub func main = () {
			var m = Maker<Pair>()
			var p = m.make()
			Console.write_line("\\{p.a},\\{p.b}")
		}
	`);
	expect(lines).toEqual(["0,0"]);
});

// ---------------------------------------------------------------------------
// Errors — loud, never silent
// ---------------------------------------------------------------------------

test("a string literal is not a type argument", () => {
	const parsed = parse_src(`
		func f = (type T, out int) {
			return 0
		}
		pub func main = () {
			f("Point")
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("takes a bare type name"))).toBe(true);
});

test("a runtime value is not a type argument", () => {
	const parsed = parse_src(`
		pub func main = () {
			var x = 5
			f(x)
		}
		func f = (type T, out int) {
			return 0
		}
	`);
	expect(
		parsed.errors.some((e) =>
			e.message.includes("unknown type 'x' — a 'type' parameter takes a struct or builtin"),
		),
	).toBe(true);
});

test("an enum is rejected as a type argument", () => {
	const parsed = parse_src(`
		enum Color {
			case red
			case green
		}
		func f = (type T, out int) {
			return 0
		}
		pub func main = () {
			f(Color)
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("'Color' is an enum"))).toBe(true);
});

test("a generic spelling is rejected — pass a concrete instantiation", () => {
	const parsed = parse_src(`
		struct Holder<T> {
			var int n
		}
		func f = (type T, out int) {
			return 0
		}
		pub func main = () {
			f(Holder)
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("'Holder' is generic"))).toBe(true);
});

test("a missing type argument errors at the call", () => {
	const parsed = parse_src(`
		func f = (type T, out int) {
			return 0
		}
		pub func main = () {
			f()
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("takes a bare type name"))).toBe(true);
});

test("'type' parameters are not allowed on methods", () => {
	const parsed = parse_src(`
		struct S {
			var int n
			func m = (type T, out int) {
				return 0
			}
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("not allowed on methods"))).toBe(true);
});

test("a declaration keyword on a 'type' parameter is an error", () => {
	const parsed = parse_src(`
		func f = (mv type T, out int) {
			return 0
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("takes no declaration keyword"))).toBe(true);
});

test("a constraint on a 'type' parameter is an error", () => {
	const parsed = parse_src(`
		func f = (type T: T != int, out int) {
			return 0
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("takes no constraint"))).toBe(true);
});

test("a default value on a 'type' parameter is an error", () => {
	const parsed = parse_src(`
		func f = (type T = int, out int) {
			return 0
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("takes no default value"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

test("the C backend builds the expanded program clean", () => {
	const parsed = parse_src(
		`
		struct Point {
			var int x = 0
			var int y = 0
		}
		mv struct Sample {
			var int count = 0
			var string label = ""
		}
		struct Pair {
			var int a
			var int b
		}
		func zero = (type T, out T) {
			var T x = T()
			return x
		}
		func name_of = (type T, out string) {
			return META.info(T).name
		}
		struct Holder<T> {
			var T value
			pub func forward = (self, out string) {
				return name_of(T)
			}
		}
		func describe = (type T, out string) {
			var s = META.info(T).name + "("
			var first = true
			#for field of META.info(T).fields {
				if !first {
					s = s + ", "
				}
				first = false
				s = s + field.name
			}
			s = s + ")"
			return s
		}
		pub func main = () {
			var p = zero(Point)
			var q = zero(Pair)
			Console.write_line(describe(Sample))
			Console.write_line(name_of(List<int>))
			Console.write_line(Holder<int>(5).forward())
			Console.write_line("\\{p.x},\\{q.a}")
		}
	`,
		{ arch: "c", platform: "linux" },
	);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "c", platform: "linux" });
	expect(built.errors ?? []).toEqual([]);
});
