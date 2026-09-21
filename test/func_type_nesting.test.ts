import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Nested func types (CLOSURE.md / SPEC "Parameters can be function types"):
// a `func` type may appear anywhere inside a signature — as a parameter
// type (`func (func (out int), out int) g`) or in a return slot
// (`out func (out int)`, a closure factory). The descriptor ABI needs no
// changes: a func value stays one word at any depth.

function run(name: string, expected: string, body: string) {
	const input = `import System\n${body}`;
	const parsed = parse_raw(input);
	if (parsed.errors.length) {
		throw new Error(`${name} REJECTED: ${parsed.errors.map((e) => e.message).join(" | ")}`);
	}
	return build_and_check_output(input, name, expected, true);
}

describe("nested func type signatures", () => {
	test("a func-typed local holding a higher-order function", async () => {
		await run(
			"func_nest_local",
			"42\n",
			`
func apply = (func (out int) f, out int) { return f() }
func twice = (func (out int) f, out int) { return f() + f() }

pub func main = (Init init) {
	var func (func (out int), out int) g = twice
	var func (out int) v = () => 21
	Console.write_line("\\{g(v)}")
}
`,
		);
	});

	test("higher-order parameter: passing a function to a function", async () => {
		await run(
			"func_nest_param",
			"7\n",
			`
func apply = (func (out int) f, out int) { return f() }
func run_with = (func (func (out int), out int) g, func (out int) v, out int) { return g(v) + 1 }

pub func main = (Init init) {
	var int base = 3
	Console.write_line("\\{run_with(apply, () => base * 2)}")
}
`,
		);
	});

	test("a named function as a nested argument through a local binding", async () => {
		await run(
			"func_nest_named_arg",
			"2\n",
			`
func twice = (func (out int) f, out int) { return f() + f() }
func inc = (out int) { return 1 }

pub func main = (Init init) {
	var func (func (out int), out int) g = twice
	Console.write_line("\\{g(inc)}")
}
`,
		);
	});

	test("closure factory: a function returning a lambda", async () => {
		await run(
			"func_nest_factory",
			"7 7\n",
			`
func make_adder = (int n, out func (out int)) {
	return () => n
}

pub func main = (Init init) {
	var func (out int) a = make_adder(7)
	Console.write_line("\\{a()} \\{a()}")
}
`,
		);
	});

	test("method taking a higher-order parameter", async () => {
		await run(
			"func_nest_method",
			"15\n",
			`
struct Engine {
	var int n

	func run = (self, func (func (out int), out int) g, func (out int) v, out int) { return g(v) + self.n }
}

func apply = (func (out int) f, out int) { return f() }

pub func main = (Init init) {
	var Engine e = Engine(5)
	Console.write_line("\\{e.run(apply, () => 10)}")
}
`,
		);
	});

	test("a capturing inline lambda argument to a higher-order parameter", async () => {
		await run(
			"func_nest_capture",
			"30\n",
			`
func apply = (func (out int) f, out int) { return f() }
func run_with = (func (func (out int), out int) g, func (out int) v, out int) { return g(v) }

pub func main = (Init init) {
	var int base = 10
	Console.write_line("\\{run_with(apply, func (out int) { return base * 3 })}")
}
`,
		);
	});

	test("a capturing lambda argument to a func-typed FIELD call", async () => {
		await run(
			"func_nest_field_call",
			"30\n",
			`
struct Plug {
	var func (func (out int), out int) f
}

func apply = (func (out int) g, out int) { return g() }

pub func main = (Init init) {
	var int base = 10
	var Plug p = Plug(apply)
	Console.write_line("\\{p.f(func (out int) { return base * 3 })}")
}
`,
		);
	});

	test("a factory returning a named function", async () => {
		await run(
			"func_nest_factory_named",
			"5\n",
			`
func five = (out int) { return 5 }
func make = (out func (out int)) { return five }

pub func main = (Init init) {
	var func (out int) f = make()
	Console.write_line("\\{f()}")
}
`,
		);
	});

	test("a trait method returning a closure (vtable dispatch)", async () => {
		await run(
			"func_nest_trait_factory",
			"9\n",
			`
trait Maker {
	func make = (self, int n, out func (out int))
}

class Adder : Maker {
	func make = (self, int n, out func (out int)) { return () => n }
}

pub func main = (Init init) {
	var Maker m = Adder()
	var func (out int) f = m.make(9)
	Console.write_line("\\{f()}")
}
`,
		);
	});
});

describe("nested func type ownership", () => {
	test("a factory-produced closure is move-only", () => {
		const parsed = parse_raw(`
import System

func make_adder = (int n, out func (out int)) {
	return () => n
}

pub func main = (Init init) {
	var func (out int) a = make_adder(7)
	var func (out int) b = a
	Console.write_line("\\{a()}")
}
`);
		expect(
			parsed.errors.some((e) => e.message.includes("moved") || e.message.includes("move")),
		).toBe(true);
	});
});
