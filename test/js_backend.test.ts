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
});
