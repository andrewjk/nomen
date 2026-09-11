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
});
