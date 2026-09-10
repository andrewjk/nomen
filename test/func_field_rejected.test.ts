import { expect, describe, test } from "vite-plus/test";

import { parse_raw } from "./parse_with_imports";

// Func-typed struct fields parse but have no working storage/assignment/call
// path in either backend. Per the documented contract they are rejected with
// guidance toward traits (SPEC "Trait Types") instead of failing later with
// confusing errors ("Parameters missing for function", "Function not found:
// <Struct>.<field>", or invalid C).

describe("func-typed struct fields are rejected", () => {
	test("field declaration errors with trait guidance", () => {
		const input = `
import System

pub struct Rule {
	pub var string name = ""
	pub var func (int, out bool) test
}

func gt3 = (int i, out bool) => i > 3

pub func main = (Init init) {
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.some((e) => e.message.includes("use a trait instead"))).toBe(true);
	});

	test("class field declaration errors with trait guidance", () => {
		const input = `
import System

pub class Handler {
	pub var func (string,) run
}

pub func main = (Init init) {
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.some((e) => e.message.includes("use a trait instead"))).toBe(true);
	});
});
