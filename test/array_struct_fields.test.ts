import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Array-typed struct fields, on aarch64, C (audit leak-checked) and JS:
// fixed-length fields seeded from an array literal or an `Array.with`
// default (auto and custom `#init`), and dynamic `Array<T>` fields read and
// written through their methods.

async function run(name: string, program: string, expected: string, audit = true): Promise<void> {
	await build_and_check_output(`import System\n${program}`, name, expected, true, {
		js: true,
		audit,
	});
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
		for i of 0 .. 4 {
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

// Audit off: a struct's destroy does not yet free an `Array<T>` field's
// buffer (FOLLOWUP.md, "Array<T> struct fields are never freed").
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
			false,
		);
	});
});
