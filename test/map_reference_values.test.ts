import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// `Map` with reference-typed values: the variadic-tuple #init is gated off
// for class/trait instantiations (the pair tuple can't satisfy the `move TV`
// chain across the variadic boundary), so construction is `Map()` + `set()`.
// Storage routes to ClassBuffer<TV>; the rehash body's `swap Buffer<TV>()`
// and Map's alloc forwards route names to ClassBuffer.

describe("Map with reference-typed values", () => {
	test("variadic pairs constructor with value-struct values", async () => {
		// Map<string, TV>(["k", TV(...)]) materializes each pair as a
		// _Tuple_string_TV whose TV field is copied through a POINTER —
		// the aarch64 pair packing handed the tuple _init the value's
		// first word instead of the address (SIGSEGV). Both shapes the
		// checker's gate does NOT cover (value structs pass it): scalars
		// only, and a string-carrying struct.
		const input = `
import System

struct Vec {
	var int x = 0
	var int y = 0
	pub func #init = (ref self, int x, int y) {
		self.x = x
		self.y = y
	}
}

struct Named {
	var string name = ""
	var int num = 0
	pub func #init = (ref self, string name, int num) {
		self.name = name
		self.num = num
	}
}

pub func main = (Init init) {
	var m = Map<string, Vec>(["a", Vec(1, 2)], ["b", Vec(3, 4)])
	Console.write("len=\\{m.length}\\n")
	var Vec va = m.get_or("a", Vec(0, 0))
	var Vec vb = m.get_or("b", Vec(0, 0))
	Console.write("a=\\{va.x},\\{va.y} b=\\{vb.x},\\{vb.y}\\n")
	var n = Map<string, Named>(["k", Named("hi", 7)])
	var Named nk = n.get_or("k", Named("no", 0))
	Console.write("k=\\{nk.name}/\\{nk.num}\\n")
	m.set("c", Vec(5, 6))
	m.set("a", Vec(-1, -2))
	var Vec vc = m.get_or("c", Vec(0, 0))
	var Vec va2 = m.get_or("a", Vec(0, 0))
	Console.write("c=\\{vc.x},\\{vc.y} a2=\\{va2.x},\\{va2.y} len=\\{m.length}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"map_reference_values_variadic_pairs",
			"len=2\na=1,2 b=3,4\nk=hi/7\nc=5,6 a2=-1,-2 len=3\n",
			true,
		);
	});

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
