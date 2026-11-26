import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

// Array-typed struct fields, on aarch64, C (audit leak-checked) and JS:
// fixed-length fields seeded from an array literal or an `Array.with`
// default (auto and custom `#init`), and dynamic `Array<T>` fields read and
// written through their methods. A dynamic field owns its buffer, so it
// needs an `mv struct`; the struct frees it (and any displaced buffer).

async function run(name: string, program: string, expected: string): Promise<void> {
	await build_and_check_output(`import System\n${program}`, name, expected, true, {
		js: true,
		audit: true,
	});
}

const system = get_library(path.resolve("core"));

function errors(source: string): string[] {
	return parse(`import System\n${source}`, system, undefined, { allow_internal: true }).errors.map(
		(e) => e.message,
	);
}

describe("fixed-length array fields", () => {
	test("literal and Array.with defaults seed the inline storage", async () => {
		await run(
			"array_field_fixed_defaults",
			`
mv struct Acc {
	var int[4] lit = [1, 2, 3, 4]
	var int[3] filled = Array.with(7, 3)
	var tag = 5

	func bump = (ref self { lit }) {
		for i of 0 .. 4 {
			self.lit.set(i, self.lit.at(i) + 10)
		}
	}

	func sum = (self, out int) {
		var total = self.tag
		for i of 0 .. self.lit.length {
			total += self.lit.at(i)
		}
		for i of 0 .. 3 {
			total += self.filled.at(i)
		}
		return total
	}
}

pub func main = () {
	var a = Acc()
	Console.write_line("\\{a.sum()}")
	a.bump()
	Console.write_line("\\{a.sum()}")
}
`,
			"36\n76\n",
		);
	});

	test("defaults are seeded before a custom #init runs", async () => {
		await run(
			"array_field_fixed_custom_init",
			`
mv struct Hasher {
	var int[8] h = Array.with(0, 8)
	var int[2] pair = [3, 4]

	pub func #init = (ref self { h }) {
		for i of 0 .. 8 {
			self.h.set(i, i * i)
		}
	}

	func total = (self, out int) {
		var t = 0
		for i of 0 .. 8 {
			t += self.h.at(i)
		}
		return t + self.pair.at(0) * self.pair.at(1)
	}
}

pub func main = () {
	const h = Hasher()
	Console.write_line("\\{h.total()}")
}
`,
			"152\n",
		);
	});

	test("string elements seed from a literal", async () => {
		await run(
			"array_field_fixed_strings",
			`
mv struct Names {
	var string[2] names = ["ada", "grace"]

	func joined = (self, mv out string) {
		return self.names.at(0) + "+" + self.names.at(1)
	}
}

pub func main = () {
	const n = Names()
	Console.write_line(n.joined())
}
`,
			"ada+grace\n",
		);
	});
});

describe("dynamic Array<T> fields", () => {
	test("set, at and at_or through the field", async () => {
		await run(
			"array_field_dynamic",
			`
mv struct Blocks {
	var Array<int> block = Array.with(0, 4)

	func fill = (ref self { block }) {
		for i of 0 .. 4 {
			if i < self.block.length {
				self.block.set(i, i * 3)
			}
		}
	}

	func total = (self, out int) {
		var t = 0
		for i of 0 .. 6 {
			t += self.block.at_or(i, 100)
		}
		return t
	}
}

pub func main = () {
	var b = Blocks()
	Console.write_line("\\{b.total()}")
	b.fill()
	Console.write_line("\\{b.total()}")
}
`,
			"200\n218\n",
		);
	});

	test("string elements are set, read and freed", async () => {
		await run(
			"array_field_dynamic_strings",
			`
mv struct Names {
	var Array<string> items = Array.with("x", 2)

	func set_first = (ref self { items }, string v) {
		if self.items.length > 0 {
			self.items.set(0, v)
		}
	}
}

pub func main = () {
	var n = Names()
	n.set_first("hello")
	Console.write_line(n.items.at_or(0, "?") + n.items.at_or(1, "?"))
}
`,
			"hellox\n",
		);
	});

	test("construction takes a fresh or moved buffer", async () => {
		await run(
			"array_field_dynamic_ctor",
			`
mv struct Holder {
	var Array<int> xs
}

func total = (Holder h, out int) {
	var t = 0
	for i of 0 .. h.xs.length {
		t += h.xs.at_or(i, 0)
	}
	return t
}

pub func main = () {
	const a = Holder(Array.with(2, 5))
	Console.write_line("\\{total(a)}")
	const Array<int> src = Array.with(3, 2)
	const b = Holder(mv src)
	Console.write_line("\\{total(b)}")
}
`,
			"10\n6\n",
		);
	});

	test("reassignment frees the displaced buffer", async () => {
		await run(
			"array_field_dynamic_reassign",
			`
mv struct Holder {
	var Array<string> names = Array.with("a", 1)
	var Array<int> nums

	pub func #init = (ref self { nums, names }) {
		self.nums = Array.with(5, 2)
		self.names = Array.with("b", 3)
	}

	func grow = (ref self { nums }) {
		self.nums = Array.with(3, 4)
	}
}

pub func main = () {
	var h = Holder()
	Console.write_line("\\{h.names.length} \\{h.nums.length}")
	h.grow()
	Console.write_line("\\{h.nums.length} \\{h.nums.at_or(0, 0)}")
	const Array<int> more = Array.with(7, 1)
	h.nums = mv more
	h.names = Array.with("c", 2)
	Console.write_line("\\{h.nums.length} \\{h.nums.at_or(0, 0)} \\{h.names.at_or(1, "?")}")
}
`,
			"3 2\n4 3\n1 7 c\n",
		);
	});
});

describe("dynamic Array<T> field rules", () => {
	test("a plain struct cannot hold one", () => {
		expect(
			errors(`
struct Plain {
	var Array<int> xs
}
`),
		).toContain(
			"'Plain' cannot be Copyable — field 'xs' owns heap memory --> mark the struct `mv struct Plain`, or remove the field",
		);
	});

	test("storing a variable or field read would share its buffer", () => {
		const found = errors(`
mv struct Holder {
	var Array<int> xs = Array.with(1, 2)
}

pub func main = () {
	var h = Holder()
	var g = Holder()
	const Array<int> a = Array.with(3, 3)
	h.xs = a
	g.xs = h.xs
	Console.write_line("\\{h.xs.length} \\{g.xs.length} \\{a.length}")
}
`);
		expect(found).toContain(
			"Storing 'a' in the Array<T> field 'h.xs' would share its buffer --> transfer it with `mv a`",
		);
		expect(found).toContain(
			"Storing 'h.xs' in the Array<T> field 'g.xs' would share its buffer --> store a fresh array (e.g. `Array.with(…)`)",
		);
	});

	test("constructing from a variable would share its buffer", () => {
		expect(
			errors(`
mv struct Holder {
	var Array<int> xs
}

pub func main = () {
	const Array<int> a = Array.with(3, 3)
	const h = Holder(a)
	Console.write_line("\\{h.xs.length} \\{a.length}")
}
`),
		).toContain(
			"Passing this array to 'xs' would share its buffer with the new struct --> transfer it with `mv a`",
		);
	});

	test("an Array<T> parameter cannot be moved into a field", () => {
		expect(
			errors(`
mv struct Names {
	var Array<string> items = Array.with("x", 2)

	func swap_in = (ref self { items }, mv Array<string> other) {
		self.items = mv other
	}
}
`),
		).toContain(
			"'other' is a parameter — an Array<T> parameter cannot be moved into a field yet --> pass the array to the struct's constructor instead",
		);
	});
});
