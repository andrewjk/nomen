import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Calling a trait method directly on a call result used to emit
// `&<call>()` in C ("cannot take the address of an rvalue"). The receiver
// is materialized once into a statement-expression temp (C) / dedicated
// slot (aarch64) and reused for both the vtable lookup and the self
// argument — so side-effecting receivers (e.g. pop) also evaluate exactly
// once, and owned receivers are reclaimed.

describe("trait method calls on rvalue receivers", () => {
	test("dispatch on a call result", async () => {
		const input = `
import System

trait Rule {
	pub func name = (self, out string)
}

class TextRule : Rule {
	pub func name = (self, out string) {
		return "text"
	}
}

pub func main = (Init init) {
	var rules = List<Rule>()
	rules.push(TextRule())
	Console.write("\\{rules.at_or_panic(0).name()}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "trait_rvalue_receiver", "text\ndone\n", true);
	});

	test("args through an rvalue receiver, and single-evaluation of pop", async () => {
		const input = `
import System

trait Greeter {
	pub func tag = (self, out string)
	pub func tag_len = (self, out int)
}

class Hello : Greeter {
	pub func tag = (self, out string) {
		return "H"
	}
	pub func tag_len = (self, out int) {
		return 1
	}
}

pub func main = (Init init) {
	var gs = List<Greeter>()
	gs.push(Hello())
	gs.push(Hello())
	Console.write("\\{gs.at_or_panic(0).tag_len()}\\n")
	Console.write("\\{gs.pop().tag()}\\n")
	Console.write("len=\\{gs.length}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		// len=1 proves pop() ran exactly once (twice would leave 0).
		await build_and_check_output(input, "trait_rvalue_receiver_args", "1\nH\nlen=1\ndone\n", true);
	});
	test("owned string results through trait dispatch do not leak", async () => {
		// A trait method returning owned heap must get the concrete-call
		// treatment (dup + free the original) on every conformer path.
		const input = `
import System

trait Greeter {
	pub func greet = (self, string suffix, out string)
}

class Hello : Greeter {
	pub func greet = (self, string suffix, out string) {
		return "hello" + suffix
	}
}

pub func main = (Init init) {
	var gs = List<Greeter>()
	gs.push(Hello())
	var Greeter g = gs.at_or_panic(0)
	Console.write("\\{g.greet("!")}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "trait_owned_string_result", "hello!\ndone\n", true);
	});
});
