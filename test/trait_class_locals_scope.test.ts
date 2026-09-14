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

	// The trait record must be tied to the DECLARATION, not a body-global
	// name map: a trait-typed local's binding used to outlive its scope, so
	// a same-named string local in a SIBLING scope was reclaimed with
	// `Rule_destroy(v)` — invalid C (`passing 'nomen_string' to parameter of
	// incompatible type 'void *'`).
	test("same-named string local in a sibling scope is not poisoned", async () => {
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
	if true {
		var Rule v = TextRule()
		Console.write("\\{v.name()}\\n")
	}
	if true {
		var string v = "str"
		Console.write("\\{v}\\n")
	}
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "trait_locals_sibling_scope", "text\nstr\ndone\n", true);
	});

	// Shadowing: an OUTER trait-typed local live across an inner same-named
	// non-trait declaration. The inner scope's reclaim must not free the
	// outer instance, and the outer local must still be reclaimed (and
	// re-destroyed on reassignment) through its own trait shim.
	test("inner same-named local shadows an outer trait local", async () => {
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

class BoldRule : Rule {
	pub func name = (self, out string) {
		return "bold"
	}
}

pub func main = (Init init) {
	var Rule v = TextRule()
	if true {
		var string v = "inner"
		Console.write("\\{v}\\n")
	}
	v = BoldRule()
	Console.write("\\{v.name()}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "trait_locals_shadowing", "inner\nbold\ndone\n", true);
	});

	// A class-backed trait local used to leave name-keyed state behind when
	// its scope ended (C: class_vars, aarch64: trait_class_locals), and a
	// same-named value-struct-backed trait local in a sibling scope then
	// inherited it. C passed the struct by value where the instance pointer
	// was expected (clang type error); aarch64 dereferenced the inline
	// struct's first field as a vtable pointer (SIGSEGV). Both backends now
	// scope their bindings (class_vars_frames / trait_class_frames), so
	// each block dispatches through its own storage form: pointer + deref
	// for the class, &local for the inline struct.
	test("value-struct trait local after a same-named class-backed sibling", async () => {
		const input = `
import System

trait Speak {
	pub func speak = (self, out string)
}

class Dog : Speak {
	pub func speak = (self, out string) {
		return "woof"
	}
}

struct Robot : Speak {
	pub var int id = 0
	pub func speak = (self, out string) {
		return "beep"
	}
	pub func #init = (ref self) {
	}
}

pub func main = (Init init) {
	if true {
		var Speak s = Dog()
		Console.write("\\{s.speak()}\\n")
	}
	if true {
		var Speak s = Robot()
		Console.write("\\{s.speak()}\\n")
	}
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"trait_locals_value_struct_sibling",
			"woof\nbeep\ndone\n",
			true,
		);
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

describe("Map with struct values", () => {
	test("Map<string, Struct> stores and loads value structs", async () => {
		const input = `
import System

pub struct LinkReference {
	pub var string url = ""
	pub var string title = ""
}

pub func main = (Init init) {
	var refs = Map<string, LinkReference>()
	var LinkReference r = LinkReference()
	r.url = "http://example"
	r.title = "Example"
	refs.set("l1", r)
	if refs.has("l1") {
		var LinkReference got = refs.get_or("l1", LinkReference())
		Console.write("\\{got.url} \\{got.title}\\n")
	}
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"map_struct_values_roundtrip",
			"http://example Example\ndone\n",
			true,
		);
	});
});
