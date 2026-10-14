import { describe, expect, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// Two checker fixes that came out of closing the B1 variadic-pair residual
// (FOLLOWUP.md), probed with Map's pairs-init shape:
//
// 1. clone_node's access_field case dropped the destructuring markers, so a
//    generic method body cloned per mono turned every `var [a, b] = expr`
//    binding into a plain field access with the binding's name ("Field not
//    found: k"). Any destructuring inside a generic struct's method hit this.
// 2. A variadic parameter registered as const, so a `ref self` method call on
//    it (`pairs.move(i)`, or any future mutation) failed with "Update to
//    const: pairs" — the call site packs a fresh array per call, so the
//    callee owns it and may mutate it.

function errors_of(input: string): string[] {
	const parsed = parse_with_imports(input);
	return parsed.errors.map((e) => e.message);
}

describe("destructuring inside a generic method body", () => {
	test("plain bindings survive the per-mono body clone", () => {
		const input = `
mv struct Holder<TK, TV> {
	var int n = 0
	pub func #init = (self, ...[TK, TV] pairs) {
		var i = 0
		while i < pairs.length; i += 1 {
			var [k, v] = pairs.at(i)
			Console.write("\\{k}\\{v}")
			self.n += 1
		}
	}
}
var Holder<string, int> h = Holder<string, int>(["a", 1], ["b", 2])
Console.write_line("\\{h.n}")
`;
		expect(errors_of(input)).toEqual([]);
	});

	test("mv bindings survive the per-mono body clone", () => {
		const input = `
mv struct Holder<TK, TV> {
	var int n = 0
	func take = (ref self, mv TK k) {
		self.n = self.n + 1
	}
	pub func #init = (self, ...[TK, TV] pairs) {
		var i = 0
		while i < pairs.length; i += 1 {
			var [mv k, mv v] = pairs.at(i)
			self.take(mv k)
		}
	}
}
var Holder<string, int> h = Holder<string, int>(["a", 1])
Console.write_line("\\{h.n}")
`;
		expect(errors_of(input)).toEqual([]);
	});
});

describe("variadic parameters are callee-owned (mutable)", () => {
	test("a ref-self call on a variadic param is accepted", () => {
		const input = `
func f = (...int xs) {
	if xs.length > 0 {
		xs.set(0, 99)
		Console.write("\\{xs.at(0)}")
	}
}
f(1, 2)
`;
		expect(errors_of(input)).toEqual([]);
	});
});
