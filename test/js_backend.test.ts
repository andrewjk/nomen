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
});
