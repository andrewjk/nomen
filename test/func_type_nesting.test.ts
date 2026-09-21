import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Nested func types (CLOSURE.md / SPEC "Function-Typed Parameters"): a func
// type may appear anywhere inside a signature — as a parameter type
// (`func (func (out int), out int) g`, `Func<Func<int, int>, int>`) or in a
// return slot (`out func (out int)`, a closure factory). The two spellings
// (`func (...)` with a trailing `out`, and `Func<..., R>` with the result
// last) parse to the same Type. The descriptor ABI needs no changes: a func
// value stays one word at any depth.

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

describe("Func<> function types", () => {
	// `Func<T1, ..., Tn>` is the same signature Type as `func (T1, ..., out Tn)`
	// with the result LAST; `void` in the result slot means no result. It is
	// usable in every type position, at any nesting depth.

	test("a local declared with Func<>", async () => {
		await run(
			"func_alias_local",
			"6\n",
			`
pub func main = (Init init) {
	var Func<int, int> f = (x) => x * 2
	Console.write_line("\\{f(3)}")
}
`,
		);
	});

	test("a zero-argument Func<>", async () => {
		await run(
			"func_alias_zero",
			"7\n",
			`
pub func main = (Init init) {
	var Func<int> f = () => 7
	Console.write_line("\\{f()}")
}
`,
		);
	});

	test("a void-result Func<> parameter and call", async () => {
		await run(
			"func_alias_void",
			"5\n",
			`
func apply_void = (Func<int, void> f, int x) { f(x) }

pub func main = (Init init) {
	apply_void(func (int x) { Console.write_line("\\{x}") }, 5)
}
`,
		);
	});

	test("a Func<> parameter and a Func<> return (closure factory)", async () => {
		// NOTE: the two interpolations are separate statements on purpose — a
		// lambda argument in a NON-FIRST interpolation slot miscompiles on
		// aarch64 (pre-existing; FOLLOWUP "Lambda argument in a non-first
		// interpolation slot").
		await run(
			"func_alias_factory",
			"9\n9\n",
			`
func run = (Func<int, int> f, int x, out int) { return f(x) }

func make = (int n, out Func<int>) {
	return () => n
}

pub func main = (Init init) {
	var Func<int> make9 = make(9)
	Console.write_line("\\{make9()}")
	Console.write_line("\\{run(() => 9, 0)}")
}
`,
		);
	});

	test("higher-order Func<> nesting", async () => {
		await run(
			"func_alias_higher",
			"6\n",
			`
func apply_to = (Func<int, int> f, out int) { return f(2) }

pub func main = (Init init) {
	var int base = 3
	Console.write_line("\\{apply_to((x) => x * base)}")
}
`,
		);
	});

	test("a deep nesting: func inside Func and Func inside func", async () => {
		await run(
			"func_alias_mixed",
			"3\n",
			`
func apply_to = (Func<int, int> f, out int) { return f(1) }
func run = (func (Func<int, int> g, out int) h, Func<int, int> f, out int) { return h(f) }

pub func main = (Init init) {
	var int base = 3
	Console.write_line("\\{run(apply_to, (x) => x * base)}")
}
`,
		);
	});

	test("a Func<>-typed struct field and its func call", async () => {
		// Nested type arguments use the alias spelling too: the keyword
		// `func (...)` form is signature syntax, not part of `Func<...>`.
		await run(
			"func_alias_field",
			"30\n",
			`
struct Plug {
	var Func<Func<int>, int> f
}

func apply = (Func<int> g, out int) { return g() }

pub func main = (Init init) {
	var int base = 10
	var Plug p = Plug(apply)
	Console.write_line("\\{p.f(func (out int) { return base * 3 })}")
}
`,
		);
	});
});

describe("Func<> rejections", () => {
	test("void is only allowed in the result slot", () => {
		const parsed = parse_raw(`
import System

pub func main = (Init init) {
	var Func<void, int> f = () => 1
	Console.write_line("\\{f()}")
}
`);
		expect(parsed.errors.some((e) => e.message.includes("result (last) type argument"))).toBe(true);
	});

	test("out void is rejected", () => {
		const parsed = parse_raw(`
import System

func make = (out void) { }

pub func main = (Init init) {
	Console.write_line("keep")
}
`);
		expect(parsed.errors.some((e) => e.message.includes("`void` has no value"))).toBe(true);
	});

	test("func types cannot be container element types", () => {
		const parsed = parse_raw(`
import System

pub func main = (Init init) {
	var List<Func<int, int>> fs = List<Func<int, int>>()
	Console.write_line("keep")
}
`);
		expect(
			parsed.errors.some((e) => e.message.includes("func types cannot be used as type arguments")),
		).toBe(true);
	});

	test("Func<> cannot be an array element type", () => {
		const parsed = parse_raw(`
import System

pub func main = (Init init) {
	var Array<Func<int, int>> fs = Array<Func<int, int>>()
	Console.write_line("keep")
}
`);
		expect(parsed.errors.some((e) => e.message.includes("array or container element"))).toBe(true);
	});
});
