import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

/**
 * The JS backend (src/build_js) walks the checked AST and emits a
 * self-contained ES module that Node runs directly. These tests pin the
 * feature-by-feature subset as it grows; `build_and_check_output(..., {
 * js: true })` additionally runs any existing test's program on all three
 * backends.
 */

/** Build + run one program on the JS backend only. */
async function js_output(
	name: string,
	source: string,
	expected: string,
	stdin?: string,
): Promise<void> {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "js" });
	expect(result.errors ?? []).toEqual([]);
	await check_output(name, result, expected, {
		arch: "js",
		audit: false,
		provideStdin: stdin,
	});
}

describe("js backend", () => {
	test("hello world", async () => {
		await js_output("js_hello", 'Console.write("hello\\n")', "hello\n");
	});

	test("variables and int arithmetic", async () => {
		await js_output(
			"js_arith",
			`
var int x = 7
var int y = 3
Console.write("\\{x + y} \\{x - y} \\{x * y} \\{x / y} \\{x % y}\\n")
`,
			"10 4 21 2 1\n",
		);
	});

	test("interpolation: string, int, float", async () => {
		await js_output(
			"js_interp",
			`
var string name = "nomen"
var int n = 42
var float f = 1.5
Console.write("\\{name} \\{n} \\{f}\\n")
`,
			"nomen 42 1.500000\n",
		);
	});

	test("if / else", async () => {
		await js_output(
			"js_if",
			`
var int n = 5
if n > 3 {
	Console.write("big\\n")
} else {
	Console.write("small\\n")
}
`,
			"big\n",
		);
	});

	test("while with update, break and continue", async () => {
		await js_output(
			"js_while",
			`
var int i = 0
while i < 6; i += 1 {
	if i == 4 {
		break
	}
	if i == 1 {
		continue
	}
	Console.write("\\{i}")
}
Console.write("\\n")
`,
			"023\n",
		);
	});

	test("for over a range", async () => {
		await js_output(
			"js_for_range",
			`
for i of 0 .. 3 {
	Console.write("\\{i}")
}
Console.write("\\n")
`,
			"012\n",
		);
	});

	test("for over an array", async () => {
		await js_output(
			"js_for_array",
			`
var int[] xs = [3, 8, 1]
for v of xs {
	Console.write("\\{v},")
}
Console.write("\\n")
`,
			"3,8,1,\n",
		);
	});

	test("functions, including a nested one", async () => {
		await js_output(
			"js_functions",
			`
func add = (int a, int b, out int) {
	return a + b
}
func outer = (int n, out int) {
	func twice = (int x, out int) {
		return x * 2
	}
	return twice(n)
}
Console.write("\\{add(1, 2)} \\{outer(21)}\\n")
`,
			"3 42\n",
		);
	});

	test("structs: constructor, fields, methods, defaults", async () => {
		await js_output(
			"js_structs",
			`
struct Options {
	var int port = 8080
	var bool verbose = false
}

mv struct P {
	var int x
	pub func bump = (ref self, int by) {
		self.x = self.x + by
	}
}

var Options o = Options()
var P p = P(1)
p.bump(2)
Console.write("\\{o.port} \\{o.verbose} \\{p.x}\\n")
`,
			"8080 false 3\n",
		);
	});

	test("casts between int and float", async () => {
		await js_output(
			"js_casts",
			`
var float f = 3.9
var int i = f as int
var float back = i as float
Console.write("\\{i} \\{back}\\n")
`,
			"3 3.000000\n",
		);
	});

	test("format specs: fixed, zero-pad, hex", async () => {
		await js_output(
			"js_formats",
			`
var float f = 1.5
var int i = 42
Console.write("\\{f:.2} \\{i:03} \\{i:x} \\{i:08X}\\n")
`,
			"1.50 042 2a 0000002A\n",
		);
	});

	test("arrays: literal, length, at, set, push", async () => {
		await js_output(
			"js_arrays",
			`
var int[] xs = [10, 20, 30]
xs.set(1, 99)
Console.write("\\{xs.length} \\{xs.at(1)}\\n")
`,
			"3 99\n",
		);
	});

	test("string methods: length, at, slice", async () => {
		await js_output(
			"js_strings",
			`
var string s = "hello"
Console.write("\\{s.length} \\{s.at(1)} \\{s.slice(1, 3)}\\n")
`,
			"5 e el\n",
		);
	});

	test("Console.read_line reads stdin", async () => {
		await js_output(
			"js_stdin",
			`
const string line = Console.read_line()
Console.write("got \\{line}\\n")
`,
			"got abc\n",
			"abc\n",
		);
	});

	test(
		"build_and_check_output's js override runs all three backends",
		{ timeout: 120_000 },
		async () => {
			await build_and_check_output('Console.write("hi\\n")', "js_override", "hi\n", false, {
				js: true,
			});
		},
	);

	test("enums: tagged values and match", async () => {
		await js_output(
			"js_enum_simple",
			`
enum Dir {
	case north
	case south
}
var Dir d = Dir.north
match d {
	case .north -> Console.write("N")
	case .south -> Console.write("S")
}
Console.write("\\n")
`,
			"N\n",
		);
	});

	test("enums: payload binding in match", async () => {
		await js_output(
			"js_enum_payload",
			`
enum Res {
	case ok(int v)
	case err
}
func get = (bool good, out Res) {
	if good {
		return Res.ok(5)
	}
	return Res.err
}
var Res r = get(true)
match r {
	case .ok(v) -> Console.write("ok \\{v}")
	case .err -> Console.write("err")
}
Console.write("\\n")
`,
			"ok 5\n",
		);
	});

	test("match with an else arm", async () => {
		await js_output(
			"js_match_else",
			`
var int x = 3
match x {
	case 1 -> Console.write("one")
	case 2 -> Console.write("two")
} else -> Console.write("other")
Console.write("\\n")
`,
			"other\n",
		);
	});

	test("match as an expression", async () => {
		await js_output(
			"js_match_expr",
			`
var int x = 2
const string label = match x {
	case 1 -> "one"
	case 2 -> "two"
} else -> "many"
Console.write("\\{label}\\n")
`,
			"two\n",
		);
	});

	test("switch statement and expression", async () => {
		await js_output(
			"js_switch",
			`
var int x = 2
switch {
	case x == 1 {
		Console.write("one")
	}
	case x == 2 {
		Console.write("two")
	}
} else {
	Console.write("other")
}
Console.write("\\n")
`,
			"two\n",
		);
		await js_output(
			"js_switch_expr",
			`
var int x = 1
const string label = switch {
	case x == 1 -> "one"
	case x == 2 -> "two"
} else -> "many"
Console.write("\\{label}\\n")
`,
			"one\n",
		);
	});

	test("if as an expression", async () => {
		await js_output(
			"js_if_expr",
			`
var int x = -2
const string label = if x > 0 -> "pos" else -> "neg"
Console.write("\\{label}\\n")
`,
			"neg\n",
		);
	});

	test("enum equality compares tag and payload", async () => {
		await js_output(
			"js_enum_eq",
			`
enum Flag {
	case on
	case off
}
var Flag a = Flag.on
var Flag b = Flag.on
var Flag c = Flag.off
Console.write("\\{a == b} \\{a == c}\\n")
`,
			"true false\n",
		);
	});

	test("generic structs", async () => {
		await js_output(
			"js_generic_struct",
			`
mv struct Box2<T> {
	var T value
}
var Box2<int> b = Box2<int>(5)
Console.write("\\{b.value}\\n")
`,
			"5\n",
		);
	});

	test("generic free functions specialize on a generic-struct argument", async () => {
		await js_output(
			"js_generic_func",
			`
mv struct Box3<T> {
	var T value
}
func unwrap<T> = (Box3<T> box, out T) {
	return box.value
}
var Box3<int> b = Box3<int>(5)
Console.write("\\{unwrap(b)}\\n")
`,
			"5\n",
		);
	});

	test("lambdas, function values, and capture", async () => {
		await js_output(
			"js_closures",
			`
func apply = (func (int, out int) f, int x, out int) {
	return f(x)
}
var func (int, out int) doubler = (x) => x * 2
func plus1 = (int x, out int) => x + 1
func make = (int n, out func (out int)) {
	return () => n
}
var func (out int) seven = make(7)
Console.write("\\{doubler(2)} \\{apply(plus1, 4)} \\{seven()}\\n")
`,
			"4 5 7\n",
		);
	});

	test("List: push, at, length, set, pop, iteration", async () => {
		await js_output(
			"js_list",
			`
var List<int> xs = List<int>()
xs.push(1)
xs.push(2)
xs.push(3)
xs.set(1, 99)
Console.write("\\{xs.length} \\{xs.at(0)} \\{xs.at(1)}\\n")
Console.write("\\{xs.pop()} \\{xs.length}\\n")
for v of xs {
	Console.write("\\{v},")
}
Console.write("\\n")
`,
			"3 1 99\n3 2\n1,99,\n",
		);
	});

	test("Map: set, get, has, remove, get_or", async () => {
		await js_output(
			"js_map",
			`
var Map<string, int> m = Map<string, int>()
m.set("a", 1)
m.set("b", 2)
Console.write("\\{m.get("a")} \\{m.has("b")} \\{m.has("z")}\\n")
m.remove("a")
Console.write("\\{m.has("a")} \\{m.get_or("z", 42)}\\n")
`,
			"1 true false\nfalse 42\n",
		);
	});

	test("StringBuilder: append overloads, length, to_string", async () => {
		await js_output(
			"js_string_builder",
			`
var StringBuilder sb = StringBuilder()
sb.append("hi")
sb.append(3)
sb.append("!")
Console.write("\\{sb.length}: \\{sb.to_string()}\\n")
`,
			"4: hi3!\n",
		);
	});

	test("Box: construction and transparent field access", async () => {
		await js_output(
			"js_box",
			`
mv struct P {
	var int x
}
var Box<P> b = Box<P>(P(5))
Console.write("\\{b.x}\\n")
var Box<int> n = Box<int>(7)
Console.write("\\{n.__value}\\n")
`,
			"5\n7\n",
		);
	});

	test("Option and Result: generic library enums with match", async () => {
		await js_output(
			"js_option_result",
			`
func find = (int[] xs, int want, out Option<int>) {
	for x of xs {
		if x == want {
			return Option.some(x)
		}
	}
	return Option.none
}
func half = (int n, out Result<int, string>) {
	if n % 2 == 0 {
		return Result.ok(n / 2)
	}
	return Result.error("odd")
}
var int[] xs = [3, 8, 1]
match find(xs, 8) {
	case .some(v) -> Console.write("some \\{v}")
	case .none -> Console.write("none")
}
Console.write(" ")
match half(8) {
	case .ok(v) -> Console.write("ok \\{v}")
	case .error(e) -> Console.write("err \\{e}")
}
Console.write("\\n")
`,
			"some 8 ok 4\n",
		);
	});

	test("anonymous structs and tuples", async () => {
		await js_output(
			"js_tuples",
			`
var x = [a = 1, b = 2]
func divmod = (int a, out [int, int]) {
	return [a / 5, a % 5]
}
var [q, r] = divmod(17)
Console.write("\\{x.a} \\{x.b} \\{q} \\{r}\\n")
`,
			"1 2 3 2\n",
		);
	});

	test("string methods", async () => {
		await js_output(
			"js_string_methods",
			`
var string s = "Hello, World"
Console.write("\\{s.contains("World")} \\{s.starts_with("Hell")} \\{s.index_of("World")}\\n")
Console.write("\\{s.to_lowercase()} \\{s.to_uppercase()}\\n")
`,
			"true true 7\nhello, world HELLO, WORLD\n",
		);
	});

	test("Math.power", async () => {
		await js_output("js_math", `Console.write("\\{Math.power(2, 10)}\\n")`, "1024\n");
	});

	test("swap assignment revalidates the source", async () => {
		await js_output(
			"js_swap",
			`
var int a = 1
var int b = 2
a = b swap 3
Console.write("\\{a} \\{b}\\n")
`,
			"2 3\n",
		);
	});

	test("custom format patterns: grouping, sections, percent, literals", async () => {
		await js_output(
			"js_patterns",
			`
var int big = 1234567
var int neg = -9876543
var int zero = 0
var float total = 1234567.891
var float ratio = 0.125
Console.write("\\{big:#,##0} \\{neg:#,##0}\\n")
Console.write("\\{zero:0.00} \\{big:0.00}\\n")
Console.write("\\{total:#,##0.00} \\{ratio:0.0%}\\n")
Console.write("\\{neg:#,##0.00;(#,##0.00)}\\n")
Console.write("\\{big:$#,##0.00} \\{big:'#'0}\\n")
Console.write("\\{total:>14#,##0.00}\\n")
`,
			"1,234,567 -9,876,543\n0.00 1234567.00\n1,234,567.89 12.5%\n(9,876,543.00)\n$1,234,567.00 #1234567\n  1,234,567.89\n",
		);
	});

	test("ref parameters write back to the caller", async () => {
		await js_output(
			"js_ref_params",
			`
func makeFive = (ref int x) {
	x = 5
}
func inner = (ref int x) {
	x = x + 1
}
func outer = (ref int x) {
	x = x + 1
	inner(ref x)
}
var int a = 0
makeFive(ref a)
var int b = 0
outer(ref b)
Console.write("\\{a} \\{b}\\n")
`,
			"5 2\n",
		);
	});

	test("for ref: element write-back", async () => {
		await js_output(
			"js_for_ref",
			`
struct P {
	var int n
}
var int[] xs = [1, 2, 3]
for ref x of xs {
	x = x * 10
}
for x of xs {
	Console.write("\\{x},")
}
Console.write("\\n")
var P[] ps = [P(1), P(2)]
for ref p of ps {
	p.n = p.n * 10
}
Console.write("\\{ps.at(0).n} \\{ps.at(1).n}\\n")
`,
			"10,20,30,\n10 20\n",
		);
	});

	test("ref array parameter and ref operand on a struct method", async () => {
		await js_output(
			"js_ref_array",
			`
func fill = (var ref int[] xs, int v) {
	for ref x of xs {
		x = v
	}
}
struct Counter {
	var int n
	pub func bump = (ref self, ref int amount) {
		self.n = self.n + amount
		amount = amount * 2
	}
}
var int[] a = [1, 2, 3]
fill(ref a, 7)
for x of a {
	Console.write("\\{x},")
}
Console.write("\\n")
var Counter c = Counter(0)
var int step = 3
c.bump(ref step)
Console.write("\\{c.n} \\{step}\\n")
`,
			"7,7,7,\n3 6\n",
		);
	});

	test("bitsets: case constants and bitwise combination", async () => {
		await js_output(
			"js_bitset",
			`
pub bitset Permissions {
	case read
	case write
	case execute
}
var flags = Permissions.read
flags = flags | Permissions.write
const can_write = (flags & Permissions.write) == Permissions.write
flags = flags ^ Permissions.execute
Console.write("\\{can_write} \\{flags}\\n")
`,
			"true 7\n",
		);
	});

	test("bitsets: nested declarations and struct fields", async () => {
		await js_output(
			"js_bitset_nested",
			`
func f = (out int) {
	pub bitset Mode {
		case a
		case b
	}
	var m = Mode.a | Mode.b
	if (m & Mode.b) == Mode.b {
		return 1
	}
	return 0
}
pub bitset Flags {
	case on
	case loud
}
struct Dev {
	var Flags flags
}
var Dev d = Dev(Flags.on)
d.flags = d.flags | Flags.loud
Console.write("\\{f()} \\{d.flags == (Flags.on | Flags.loud)}\\n")
`,
			"1 true\n",
		);
	});

	test("traits: devirtualized trait variable", async () => {
		await js_output(
			"js_trait",
			`
pub trait Printable {
	func to_string = (self, out string)
}
pub struct Point: Printable {
	pub var int x
	pub var int y
	pub func to_string = (self, out string) {
		return "Point(\\{self.x}, \\{self.y})"
	}
}
const Printable pt = Point(1, 2)
const string s = pt.to_string()
Console.write("\\{s}\\n")
`,
			"Point(1, 2)\n",
		);
	});

	test("traits: dynamic dispatch on trait-typed parameters and returns", async () => {
		await js_output(
			"js_trait_dispatch",
			`
pub trait Shape {
	func area = (self, out int)
}
struct Sq: Shape {
	var int side
	pub func area = (self, out int) {
		return self.side * self.side
	}
}
struct Rect: Shape {
	var int w
	var int h
	pub func area = (self, out int) {
		return self.w * self.h
	}
}
func total = (Shape a, Shape b, out int) {
	return a.area() + b.area()
}
func make = (out Shape) {
	return Sq(3)
}
var List<Shape> shapes = List<Shape>()
shapes.push(Sq(2))
shapes.push(Rect(2, 5))
var int sum = 0
for s of shapes {
	sum = sum + s.area()
}
Console.write("\\{total(Sq(3), Rect(2, 5))} \\{make().area()} \\{sum}\\n")
`,
			"19 9 14\n",
		);
	});

	test("auto-derived Equatable and Stringable methods", async () => {
		await js_output(
			"js_derived",
			`
pub struct Point: Equatable, Stringable {
	pub var int x
	pub var int y
}
const a = Point(1, 2)
const b = Point(1, 2)
const c = Point(1, 3)
const bool same = a == b
const bool diff = a != c
const string s = a.to_string()
Console.write("\\{same} \\{diff} \\{s}\\n")
`,
			"true true Point(x=1, y=2)\n",
		);
	});

	test("Set: add, has, get_or, remove, copy, length", async () => {
		await js_output(
			"js_set",
			`
var Set<int> s = Set<int>()
s.add(1)
s.add(2)
s.add(2)
Console.write("\\{s.length} \\{s.has(1)} \\{s.has(9)}\\n")
s.remove(1)
var Set<int> t = s.copy()
t.add(7)
Console.write("\\{s.length} \\{s.get_or(9, 42)} \\{t.length}\\n")
`,
			"2 true false\n1 42 2\n",
		);
	});

	test("Array<T> constructor and Array.with", async () => {
		await js_output(
			"js_array_ctor",
			`
const ints = Array<int>(1, 2, 3)
const zeros = Array.with(0, 3)
Console.write("\\{ints.length} \\{zeros.at(2)} \\{zeros.length}\\n")
`,
			"3 0 3\n",
		);
	});

	test("nullable scalars and int-valued length comparisons", async () => {
		await js_output(
			"js_nullable",
			`
var int? x = null
var string? name = null
if x == null {
	Console.write("none")
}
if name == null {
	Console.write("!")
}
Console.write("\\n")
x = 5
var int[] xs = [1, 2, 3]
if xs.length == 3 {
	Console.write("\\{x}\\n")
}
`,
			"none!\n5\n",
		);
	});
});
