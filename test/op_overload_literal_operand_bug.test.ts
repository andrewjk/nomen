import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// BUG: on the C backend, calling an overloaded operator with a freshly-
// constructed struct (a literal / rvalue) as an operand emits invalid C:
// `a = M_add(&a, &M_init(5));` — "cannot take the address of an rvalue".
//
// Passing a *variable* operand (`a + b`) works fine on both backends; only a
// struct-literal operand breaks C codegen. aarch64 is unaffected. The fix is
// to spill the rvalue operand to a temporary before taking its address.

describe("operator overload struct-literal operand (C backend) bug", () => {
	test("overload with struct literal right operand compiles and runs", async () => {
		const input = `
struct M {
	var int c
	func #op_add = (self, M other, out M) {
		return M(self.c + other.c)
	}
	func to_string = (self, out string) {
		return "\\{self.c}"
	}
}
var M a = M(1)
a = a + M(5)
Console.write("\\{a}")
`;
		await build_and_check_output(input, "op_overload_literal_operand_bug", "6");
	});
});
