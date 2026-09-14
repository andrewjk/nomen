import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// A lambda (`(x) => x * 3`) used as a func-typed VALUE. The checker gives
// each anonymous lambda a program-unique emission name (both backends lower
// it to a file-scope function: aarch64 passes `adr` of the label, C hoists
// the definition to file scope and uses the identifier), and infers its
// parameter/return types from the target signature. Covers call arguments —
// including a func-typed struct FIELD's ctor parameter — func-typed locals,
// and func-typed field assignment.

function run(name: string, expected: string, body: string) {
	const input = `import System\n${body}`;
	const parsed = parse_raw(input);
	if (parsed.errors.length) {
		throw new Error(`${name} REJECTED: ${parsed.errors.map((e) => e.message).join(" | ")}`);
	}
	return build_and_check_output(input, name, expected, true);
}

describe("lambda as a func-typed value", () => {
	test("direct call argument", async () => {
		await run(
			"lambda_arg_call",
			"12\n",
			`
func apply = (func (int, out int) f, int x, out int) { return f(x) }
pub func main = (Init init) {
	Console.write_line("\\{apply((y) => y * 4, 3)}")
}
`,
		);
	});

	test("ctor argument to a func-typed field (Rule shape)", async () => {
		await run(
			"lambda_arg_ctor",
			"12\n",
			`
struct Rule {
	var func (int, out int) f
}
pub func main = (Init init) {
	var Rule r = Rule((x) => x * 3)
	Console.write_line("\\{r.f(4)}")
}
`,
		);
	});

	test("func-typed local declared with a lambda", async () => {
		await run(
			"lambda_decl_local",
			"12\n",
			`
func apply = (func (int, out int) f, int x, out int) { return f(x) }
pub func main = (Init init) {
	var func (int, out int) quad = (y) => y * 4
	Console.write_line("\\{apply(quad, 3)}")
}
`,
		);
	});

	test("two lambdas in one program get distinct functions", async () => {
		await run(
			"lambda_arg_two",
			"12\n4\n",
			`
func apply = (func (int, out int) f, int x, out int) { return f(x) }
pub func main = (Init init) {
	Console.write_line("\\{apply((y) => y * 4, 3)}")
	Console.write_line("\\{apply((y) => y + 1, 3)}")
}
`,
		);
	});

	test("lambda with a string param and return", async () => {
		await run(
			"lambda_arg_string",
			"hi!\n",
			`
func apply_str = (func (string, out string) f, string s, out string) { return f(s) }
pub func main = (Init init) {
	Console.write_line(apply_str((t) => t + "!", "hi"))
}
`,
		);
	});

	test("field assignment (r.f = lambda), twice", async () => {
		await run(
			"lambda_assign_field",
			"12\n5\n",
			`
func dbl = (int x, out int) { return x * 2 }
struct Rule {
	var func (int, out int) f
}
pub func main = (Init init) {
	var Rule r = Rule(dbl)
	r.f = (x) => x * 3
	Console.write_line("\\{r.f(4)}")
	r.f = (x) => x + 1
	Console.write_line("\\{r.f(4)}")
}
`,
		);
	});

	test("field default value lambda", async () => {
		await run(
			"lambda_field_default",
			"10\n",
			`
struct Rule {
	var func (int, out int) f = (x) => x + 10
}
pub func main = (Init init) {
	var Rule r = Rule()
	Console.write_line("\\{r.f(0)}")
}
`,
		);
	});

	test("file-scope func-typed declaration with a lambda", async () => {
		await run(
			"lambda_global_decl",
			"12\n",
			`
func apply = (func (int, out int) f, int x, out int) { return f(x) }
var func (int, out int) quad = (y) => y * 4
pub func main = (Init init) {
	Console.write_line("\\{apply(quad, 3)}")
}
`,
		);
	});

	test("lambda inside a generic function (cloned per instantiation)", async () => {
		await run(
			"lambda_generic",
			"20\n200\n",
			`
struct Box<T> {
	var T value
}
func apply = (func (int, out int) f, int x, out int) { return f(x) }
func twice<T> = (Box<T> box, out int) {
	return apply((y) => y * 2, box.value)
}
pub func main = (Init init) {
	var Box<int> a = Box<int>(10)
	var Box<int> b = Box<int>(100)
	Console.write_line("\\{twice(a)}")
	Console.write_line("\\{twice(b)}")
}
`,
		);
	});

	test("lambda with a mismatched parameter count is rejected", () => {
		const input = `import System
func apply = (func (int, out int) f, int x, out int) { return f(x) }
pub func main = (Init init) {
	var func (int, out int) f = (a, b) => a + b
	Console.write_line("\\{apply(f, 3)}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});
