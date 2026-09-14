import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// `Map` with reference-typed values: the variadic-tuple #init is gated off
// for class/trait instantiations (the pair tuple can't satisfy the `move TV`
// chain across the variadic boundary), so construction is `Map()` + `set()`.
// Storage routes to ClassBuffer<TV>; the rehash body's `swap Buffer<TV>()`
// and Map's alloc_T forwards route names to ClassBuffer.

describe("Map with reference-typed values", () => {
	test("class/trait values set, get, and destroy soundly", async () => {
		const input = `
import System

trait Animal {
	pub func speak = (self, out string)
}

class Dog : Animal {
	pub func speak = (self, out string) {
		return "woof"
	}
}

class Cat : Animal {
	pub func speak = (self, out string) {
		return "meow"
	}
}

pub func main = (Init init) {
	var m = Map<string, Animal>()
	m.set("d", Dog())
	m.set("c", Cat())
	m.set("d2", Dog())
	if m.has("d") {
		var Animal a = m.get_or("d", Dog())
		Console.write("\\{a.speak()}\\n")
	}
	if m.has("c") {
		var Animal c = m.get_or("c", Dog())
		Console.write("\\{c.speak()}\\n")
	}
	Console.write("len=\\{m.length}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "map_reference_values", "woof\nmeow\nlen=3\ndone\n", true);
	});

	test("value-struct values (allmark's LinkReference shape) set/get/overwrite", async () => {
		// The allmark port's `Map<string, int>` + parallel `List<LinkReference>`
		// pattern collapses back to `Map<string, LinkReference>` — a value
		// struct of strings works as TV via `Map()` + `set()` (no variadic
		// pairs literal; that form stays gated for reference/aggregate TVs).
		const input = `
import System

pub struct LinkReference {
	pub var string url = ""
	pub var string title = ""
}

pub func main = (Init init) {
	var refs = Map<string, LinkReference>()
	var LinkReference a = LinkReference()
	a.url = "https://one"
	a.title = "One"
	refs.set("a", move a)
	var LinkReference b = LinkReference()
	b.url = "https://two"
	b.title = "Two"
	refs.set("b", move b)
	// Overwrite an existing key: the displaced value must be reclaimed.
	refs.set("a", LinkReference())
	Console.write("has=\\{refs.has("b")} len=\\{refs.length}\\n")
	Console.write("[\\{refs.get_or("b", LinkReference()).url}|\\{refs.get_or("b", LinkReference()).title}]\\n")
	Console.write("[\\{refs.get_or("a", LinkReference()).url}]\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"map_reference_values_struct",
			"has=true len=2\n[https://two|Two]\n[]\n",
			true,
		);
	});
});
