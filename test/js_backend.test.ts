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

	test("System library code is lowered on demand (Text.Regex)", async () => {
		await js_output(
			"js_regex",
			`
Console.write("\\{Regex.test("a+b", "xaaab")} \\{Regex.test("^[0-9]+$", "12345")} \\{Regex.test("^[0-9]+$", "12a45")}\\n")
Console.write("\\{Regex.match("[0-9]+", "abc123def")}\\n")
Console.write("\\{Regex.count("[aeiou]", "programming")}\\n")
Console.write("\\{Regex.replace_all("[0-9]+", "a1b22c333", "#")}\\n")
`,
			"true true false\n123\n3\na#b#c#\n",
		);
	});

	test("System library code is lowered on demand (Text.Json)", async () => {
		await js_output(
			"js_json",
			`
Console.write("\\{Json.serialize("hi \\"there\\"")}\\n")
Console.write("\\{Json.deserialize("\\"a\\\\\\"b\\"")}\\n")
`,
			'"hi \\"there\\""\na"b\n',
		);
	});

	test("char literal quoting and library UTF-8 iteration", async () => {
		await js_output(
			"js_chars",
			`
var Chars cs = Chars("héllo")
var int n = 0
while cs.has_next() {
	var int cp = cs.next()
	n = n + 1
}
var StringBuilder sb = StringBuilder()
sb.append_char('"')
sb.append("x")
Console.write("\\{n} \\{sb.to_string()}\\n")
`,
			'5 "x\n',
		);
	});

	test("int.parse and the parse_int helper", async () => {
		await js_output(
			"js_int_parse",
			`
const int n = int.parse("42")
const int neg = int.parse("-7")
const int via_init = parse_int("12")
Console.write("\\{n + neg + via_init}\\n")
`,
			"47\n",
		);
	});

	test("Random (seeded) and Time", async () => {
		await js_output(
			"js_random_time",
			`
var Random rng = Random(42)
const int a = rng.below(100) as int
const int b = rng.range(10, 20) as int
if a >= 0 && a < 100 && b >= 10 && b <= 20 {
	Console.write("range ok")
}
const int ms = Time.now_ms() as int
if ms > 0 {
	Console.write(" clock ok")
}
Time.sleep_ms(1)
Console.write("\\n")
`,
			"range ok clock ok\n",
		);
	});

	test("custom struct casts (#op_as) and enum case casts", async () => {
		await js_output(
			"js_casts",
			`
struct Dog {
	var int value
	func #op_as = (self, out int) {
		return self.value * 2
	}
}
enum Res {
	case ok(int v)
	case err
}
var Dog d = Dog(21)
const int v = d as int
var Res r = Res.ok(7)
var Res.ok ok = r as Res.ok
var Res back = ok as Res
match back {
	case .ok(payload) -> Console.write("ok \\{payload}")
	case .err -> Console.write("err")
}
Console.write(" \\{v}\\n")
`,
			"ok 7 42\n",
		);
	});

	test("struct, array, and tuple destructuring", async () => {
		await js_output(
			"js_destructure",
			`
struct Point {
	var int x
	var int y
}
const Point p = Point(3, 4)
var [x, y] = p
const int[] arr = [5, 6, 7]
var [a, _, c] = arr
var [t1, t2] = [11, 22]
Console.write("\\{x} \\{y} \\{a} \\{c} \\{t1} \\{t2}\\n")
`,
			"3 4 5 7 11 22\n",
		);
	});

	test("variadic params, default params, func fields, recursion", async () => {
		await js_output(
			"js_func_shapes",
			`
func count = (...string items, out int) => items.length
func greet = (string name, string suffix = "!") {
	Console.write("\\{name}\\{suffix}\\n")
}
struct Handler {
	var func (int, out int) f
}
func fact = (int n, out int) {
	if n <= 1 {
		return 1
	}
	return n * fact(n - 1)
}
greet("hi")
greet("bye", "?")
var Handler h = Handler((x) => x * 3)
Console.write("\\{count("a", "b", "c")} \\{h.f(4)} \\{fact(5)}\\n")
`,
			"hi!\nbye?\n3 12 120\n",
		);
	});

	test("custom #op_add on a struct", async () => {
		await js_output(
			"js_op_add",
			`
struct Vec {
	var int x
	pub func #op_add = (self, Vec other, out Vec) {
		return Vec(self.x + other.x)
	}
}
const Vec a = Vec(2) + Vec(5)
Console.write("\\{a.x}\\n")
`,
			"7\n",
		);
	});

	test("user #init constructor bodies run", async () => {
		await js_output(
			"js_user_init",
			`
struct P {
	var int x
	var int y
	func #init = (self, int v) {
		self.x = v * 2
		self.y = v + 1
	}
}
var P p = P(5)
Console.write("\\{p.x} \\{p.y}\\n")
`,
			"10 6\n",
		);
	});

	test("library #init bodies run (Random seeding)", async () => {
		await js_output(
			"js_lib_init",
			`
var Random seeded = Random(7)
const int b = seeded.below(1000000) as int
var Random again = Random(7)
const int c = again.below(1000000) as int
if b >= 0 && b == c {
	Console.write("ok\\n")
}
`,
			"ok\n",
		);
	});

	test("value-struct copy semantics: binding, assignment, fields, returns", async () => {
		await js_output(
			"js_struct_copy",
			`
struct Nested {
	var int n
}
struct Wrapper {
	var Nested inner
}
struct P {
	var int x
	var int y
}
var P a = P(1, 2)
var P b = a
b.x = 99
var P c = P(3, 4)
var P d = P(4, 5)
d = c
d.x = 7
var Nested i = Nested(1)
var Wrapper o = Wrapper(i)
i.n = 7
Console.write("\\{a.x} \\{b.x} \\{c.x} \\{d.x} \\{o.inner.n} \\{i.n}\\n")
`,
			"1 99 3 7 1 7\n",
		);
	});

	test("value-struct copies on return and closure capture", async () => {
		await js_output(
			"js_struct_copy_return",
			`
struct P {
	var int x
}
struct Box2 {
	var P p
}
func get = (Box2 b, out P) {
	return b.p
}
var Box2 box = Box2(P(3))
var P got = get(box)
got.x = 8
var P src = P(1)
var func (out int) captured = () => src.x
src.x = 2
Console.write("\\{box.p.x} \\{got.x} \\{captured()}\\n")
`,
			"3 8 1\n",
		);
	});

	test("container stores copy value structs", async () => {
		await js_output(
			"js_struct_container_copy",
			`
struct P {
	var int x
}
var P p = P(1)
var List<P> xs = List<P>()
xs.push(p)
p.x = 9
var Map<string, P> m = Map<string, P>()
m.set("a", p)
p.x = 10
var Set<int> s = Set<int>()
s.add(1)
Console.write("\\{xs.at(0).x} \\{m.get("a").x} \\{s.has(1)}\\n")
`,
			"1 9 true\n",
		);
	});

	test("array concatenation, Hashable, and Utf8 helpers", async () => {
		await js_output(
			"js_misc_ops",
			`
pub struct P: Hashable {
	pub var int n
}
const int[] a = [1, 2]
const int[] b = [3, 4]
const int[] c = a + b
const string e = Utf8.encode(233)
Console.write("\\{c.length} \\{Utf8.char_count("héllo")} \\{e} \\{P(7).hash() == P(7).hash()}\\n")
`,
			"4 5 é true\n",
		);
	});

	test("views (string and array slices), generic and anonymous enums", async () => {
		await js_output(
			"js_views",
			`
enum Pair<T> {
	case both(T a, T b)
	case none
}
const string str = "hello world"
view v = str.slice(0, 5)
const int[] nums = [10, 20, 30, 40, 50]
view s = nums.slice(1, 4)
var Pair<int> p = Pair.both(1, 2)
match p {
	case .both(a, b) -> Console.write("\\{a} \\{b} ")
	case .none -> Console.write("none ")
}
Console.write("\\{v.to_string()} \\{v.length} \\{s.length} \\{s.at(2)}\\n")
`,
			"1 2 hello 5 3 40\n",
		);
	});

	test("enum values render as their tag", async () => {
		await js_output(
			"js_enum_print",
			`
enum Dir {
	case north
	case south
}
pub bitset F {
	case a
	case b
}
var Dir d = Dir.south
var f = F.a | F.b
Console.write("\\{d} \\{f}\\n")
`,
			"1 3\n",
		);
	});

	test("for update clause and char arithmetic", async () => {
		await js_output(
			"js_for_update",
			`
var int total = 0
for i of 0 .. 5; total += i {
}
var int[] xs = [10, 20, 30]
var int acc = 0
for x of xs; acc += x {
}
var char c = 'a'
var int n = c as int
Console.write("\\{total} \\{acc} \\{n + 1 as char}\\n")
`,
			"10 60 98\n",
		);
	});

	test("64-bit wrapping arithmetic and sized-int stores", async () => {
		await js_output(
			"js_overflow",
			`
var int64 big = 9223372036854775807
big = big + 1
var uint64 u = 18446744073709551615
u = u + 1
var int8 b = 100
b = b + 100
Console.write("\\{big} \\{u} \\{b} \\{u >> 60}\\n")
`,
			"-9223372036854775808 0 -56 0\n",
		);
	});

	test("call arguments in match/if/switch conditions", async () => {
		await js_output(
			"js_condition_calls",
			`
func find = (Array<int> xs, int want, out Option<int>) {
	for x of xs {
		if x == want {
			return Option.some(x)
		}
	}
	return Option.none
}
func is_big = (Array<int> xs, out bool) {
	return xs.length > 2
}
const int v = match find([1, 2, 3], 2) {
	case .some(x) -> x
	case .none -> -1
}
match find(Array<int>(1), 9) {
	case .some(x) -> Console.write("some")
	case .none -> Console.write("none")
}
const string s = if is_big([1, 2, 3]) -> "big" else -> "small"
Console.write(" \\{v} \\{s}\\n")
`,
			"none 2 big\n",
		);
	});

	test("List of structs iterates by slot and refs to fields", async () => {
		await js_output(
			"js_list_structs",
			`
struct P {
	var int x
	pub func get = (self, out int) {
		return self.x
	}
}
struct Holder {
	var int n
}
func bump = (ref int x) {
	x = x + 10
}
var List<P> xs = List<P>()
xs.push(P(1))
xs.push(P(2))
var int sum = 0
for p of xs {
	sum = sum + p.get()
}
var Holder h = Holder(5)
bump(ref h.n)
var int[] arr = [1, 2]
bump(ref arr.at(0))
Console.write("\\{sum} \\{h.n} \\{arr.at(0)}\\n")
`,
			"3 15 11\n",
		);
	});

	test("primitive hash() and owning structs with Box", async () => {
		await js_output(
			"js_hash_box",
			`
mv struct Cell {
	pub var int v
}
mv struct Holder {
	pub var Box<Cell> b
}
const string a = "abc"
const string b = "abd"
var Holder h = Holder(Box<Cell>(Cell(5)))
h.b.v = 7
Console.write("\\{a.hash() == a.hash()} \\{a.hash() == b.hash()} \\{h.b.v}\\n")
`,
			"true false 7\n",
		);
	});

	test("enum payloads copy struct values on construction and match", async () => {
		await js_output(
			"js_enum_payload_copy",
			`
struct P {
	var int x
}
enum E {
	case has(P p)
}
var P p = P(1)
var E e = E.has(p)
p.x = 9
match e {
	case .has(q) -> q.x = 5
}
match e {
	case .has(q) -> Console.write("\\{q.x}")
}
Console.write("\\n")
`,
			"1\n",
		);
	});

	test("hoisted temps are inlined at their use site (loop conditions)", async () => {
		await js_output(
			"js_alloc_inline",
			`
var int[] xs = [5, 2, 9, 1, 5, 6]
for i of 1 .. xs.length {
	var int j = i
	while j > 0 && xs.at(j - 1) > xs.at(j) {
		const int tmp = xs.at(j)
		xs.set(j, xs.at(j - 1))
		xs.set(j - 1, tmp)
		j -= 1
	}
}
for x of xs {
	Console.write("\\{x} ")
}
Console.write("\\n")
`,
			"1 2 5 5 6 9 \n",
		);
	});
});
