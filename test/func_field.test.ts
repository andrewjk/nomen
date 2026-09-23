import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Func-typed struct/class fields (`var func (int, out bool) test`) store an
// 8-byte code pointer. They are non-owning (nothing to destroy), so struct
// copies are sound, and `s.f(args)` lowers to an indirect call through the
// field (C casts the field to the signature; aarch64 loads it and `blr`s).
// This enables the allmark port's TS `BlockRule = { test: (line) => bool }`
// shape directly.

function run(name: string, expected: string, body: string) {
	const input = `import System\n${body}`;
	const parsed = parse_raw(input);
	if (parsed.errors.length) {
		throw new Error(`${name} REJECTED: ${parsed.errors.map((e) => e.message).join(" | ")}`);
	}
	return build_and_check_output(input, name, expected, true);
}

describe("func-typed struct fields", () => {
	test("ctor value + call, int param", async () => {
		await run(
			"ff_int",
			"42\ndone\n",
			`
func dbl = (int x, out int) { return x * 2 }
struct Rule {
	var func (int, out int) f
}
pub func main = (Init init) {
	var Rule r = Rule(dbl)
	Console.write_line("\\{r.f(21)}")
	Console.write_line("done")
}
`,
		);
	});

	test("string param — the BlockRule shape", async () => {
		await run(
			"ff_string",
			"true false\n",
			`
func is_hash = (string s, out bool) { return s.at_or(0, ' ') == '#' }
func is_quote = (string s, out bool) { return s.at_or(0, ' ') == '>' }
struct Rule {
	var func (string, out bool) test
}
pub func main = (Init init) {
	var Rule r = Rule(is_hash)
	Console.write("\\{r.test("# h")} ")
	r.test = is_quote
	Console.write_line("\\{r.test("# h")}")
}
`,
		);
	});

	test("struct copy shares the code pointer (non-owning)", async () => {
		await run(
			"ff_copy",
			"6\n",
			`
func dbl = (int x, out int) { return x * 2 }
struct Rule {
	var func (int, out int) f
}
pub func main = (Init init) {
	var Rule a = Rule(dbl)
	var Rule b = a
	Console.write_line("\\{b.f(3)}")
}
`,
		);
	});

	test("field default value", async () => {
		await run(
			"ff_default",
			"10\n",
			`
func plus_ten = (int x, out int) { return x + 10 }
struct Rule {
	var func (int, out int) f = plus_ten
}
pub func main = (Init init) {
	var Rule r = Rule()
	Console.write_line("\\{r.f(0)}")
}
`,
		);
	});

	test("self.f(...) inside a method", async () => {
		await run(
			"ff_self",
			"7\n",
			`
func id = (int x, out int) { return x }
struct Rule {
	var func (int, out int) f
	pub func run = (self, int x, out int) { return self.f(x) }
}
pub func main = (Init init) {
	var Rule r = Rule(id)
	Console.write_line("\\{r.run(7)}")
}
`,
		);
	});

	test("class func field", async () => {
		await run(
			"ff_class",
			"42\n",
			`
func dbl = (int x, out int) { return x * 2 }
class Rule {
	var func (int, out int) f
}
pub func main = (Init init) {
	var Rule r = Rule(dbl)
	Console.write_line("\\{r.f(21)}")
}
`,
		);
	});

	test("value-struct func field round-trips through a List<T>", async () => {
		// The ruleset shape the allmark port needs: rules pushed into a
		// List, read back with at_or_panic, then called through the field.
		// Historically SIGSEGV'd on aarch64 (the direct-construction twin
		// worked), so the port kept trait classes for its rulesets.
		await run(
			"ff_list_roundtrip",
			"r:hash\nr2:quote\nfor:hash\nfor:other\ndone\n",
			`
func is_hash = (string s, out bool) { return s.at_or(0, ' ') == '#' }
func is_quote = (string s, out bool) { return s.at_or(0, ' ') == '>' }
struct BlockRule {
	var func (string, out bool) test
}
pub func main = (Init init) {
	var List<BlockRule> blocks = List<BlockRule>()
	blocks.push(BlockRule(is_hash))
	blocks.push(BlockRule(is_quote))
	var BlockRule r = blocks.at_or_panic(0)
	if r.test("# h") {
		Console.write_line("r:hash")
	}
	var BlockRule r2 = blocks.at_or_panic(1)
	if r2.test("> q") {
		Console.write_line("r2:quote")
	}
	for b of blocks {
		if b.test("# x") {
			Console.write_line("for:hash")
		} else {
			Console.write_line("for:other")
		}
	}
	Console.write_line("done")
}
`,
		);
	});

	test("List round-trip survives growth and a lifted field call", async () => {
		await run(
			"ff_list_growth",
			"256\n10\ndone\n",
			`
func dbl = (int n, out int) { return n * 2 }
struct Rule {
	var string name
	var func (int, out int) f
}
pub func main = (Init init) {
	var List<Rule> rules = List<Rule>()
	var int i = 0
	while i < 64; i += 1 {
		rules.push(Rule("r", dbl))
	}
	var int total = 0
	for r of rules {
		total += r.f(2)
	}
	var func (int, out int) lifted = rules.at_or_panic(10).f
	Console.write_line("\\{total}")
	Console.write_line("\\{lifted(5)}")
	Console.write_line("done")
}
`,
		);
	});

	test("void lambda in a func field (C emitted a value return for it)", async () => {
		// `() => Console.write_line(...)` is an arrow body whose single
		// expression is a VOID call. The lambda's return type used to stay
		// unnamed and the C backend lowered the implicit return as
		// `long _return_val = <void call>` — a compile error.
		await run(
			"ff_void_lambda",
			"lambda b\ndone\n",
			`
struct Rule {
	var func () f
}
pub func main = (Init init) {
	var Rule r = Rule(() => Console.write_line("lambda b"))
	r.f()
	Console.write_line("done")
}
`,
		);
	});

	test("heap string returned through an indirect call", async () => {
		// `call_it(shout, 42)` — a fresh heap string (to_string + concat)
		// crossing a func-typed value. Cross-function leakage of the build
		// status's variable_types map once mis-typed `v.to_string()` here (a
		// library function's `view string v` param answered the lookup), and
		// the same shape segfaulted both backends.
		await run(
			"ff_heap_indirect_return",
			"42!\ndone\n",
			`
func shout = (int v, out string) {
	return v.to_string() + "!"
}
func call_it = (func (int, out string) f, int x, out string) {
	return f(x)
}
pub func main = (Init init) {
	var string r = call_it(shout, 42)
	Console.write_line(r)
	Console.write_line("done")
}
`,
		);
	});
});
