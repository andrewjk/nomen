import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// trait_class_locals is name-keyed per-function state in both backends. A
// trait-typed local named `v` inside the monomorphized List<Trait>.copy used
// to leak into EVERY later function body sharing a local name, so their
// auto-free emitted `Trait_destroy(v)` for string/int elements — invalid C
// (`passing 'nomen_string' to parameter of incompatible type 'void *'`).
describe("trait_class_locals scoping", () => {
	test("List<Trait> and List<string> fields coexist (C auto-free)", async () => {
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

class Holder {
	pub var List<Rule> rules = List<Rule>()
	pub var List<string> names = List<string>()

	pub func #init = (ref self) {
	}
}

pub func main = (Init init) {
	var h = Holder()
	h.rules.push(TextRule())
	h.names.push("x")
	Console.write("\\{h.names.at_or_panic(0)}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "trait_locals_scope_holder", "x\ndone\n", true);
	});

	test("by-value List<string> param after a trait list compiles", async () => {
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

func count = (List<string> items, out int) {
	return items.length
}

pub func main = (Init init) {
	var rules = List<Rule>()
	rules.push(TextRule())
	var items = List<string>()
	items.push("a")
	items.push("b")
	Console.write("\\{count(items)}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "trait_locals_scope_param", "2\ndone\n", true);
	});
});

test("Map<string,string> rehash next to a trait list", async () => {
	// The Map rehash body declares locals `k`/`v`; before the per-function
	// scoping those names could be poisoned by a trait-typed local in
	// another monomorphized body, emitting `Trait_destroy(v)` for the
	// rehashed strings (invalid C).
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

	var m = Map<string, string>()
	m.set("a", "1")
	m.set("b", "2")
	m.set("c", "3")
	m.set("d", "4")
	m.set("e", "5")
	m.set("f", "6")
	m.set("g", "7")
	var first = m.get_or("g", "")
	Console.write("\\{first}\\n")
}
`;
	const parsed = parse_raw(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "trait_locals_scope_map_rehash", "7\n", true);
});
