import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Constraint-verification gaps: (1) a string literal's compile-time byte
// length now feeds `self.length` constraints, so `slice` on a literal
// verifies; (2) same-base offset arithmetic (`list.at(list.length - 1)`
// under a `list.length > 0` guard) is decided algebraically; and (3) an
// offset argument over a dotted path (`l.length - 1`) carries shifted bounds
// and an alias to the full path.

describe("constraint verification: literals and length arithmetic", () => {
	test("slice on a string literal verifies against the literal length", async () => {
		const input = `
import System

pub func main = (Init init) {
	var view mid = "abc".slice(1, 3)
	Console.write("\\{mid}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "constraint_literal_slice", "bc\ndone\n", true);
	});

	test("at(length - 1) under a length guard verifies", async () => {
		const input = `
import System

pub func main = (Init init) {
	var l = List<int>()
	l.push(10)
	l.push(20)
	if l.length > 0 {
		var int last = l.at(l.length - 1)
		Console.write("last=\\{last}\\n")
	}
	var int first = l.at(0)
	Console.write("first=\\{first}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"constraint_last_element",
			"last=20\nfirst=10\ndone\n",
			true,
		);
	});
});
