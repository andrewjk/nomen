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
});
