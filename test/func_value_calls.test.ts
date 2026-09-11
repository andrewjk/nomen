import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Func-typed locals are callable for any signature, including `out` returns
// (previously only no-return signatures initialized from library functions
// worked). Reassignment is signature-checked. Both backends materialize the
// call as an indirect load + call through the stored function pointer.

describe("func-typed local values", () => {
	test("no-return signature from a user function", async () => {
		const input = `
import System

func shout = (string s) {
	Console.write(s)
}

pub func main = (Init init) {
	var func (string,) f1 = shout
	f1("hey\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "funcval_no_return", "hey\ndone\n", true);
	});

	test("out-returning signature dispatches with the result", async () => {
		const input = `
import System

func gt3 = (int i, out bool) => i > 3
func len_of = (string s, out int) => s.length

pub func main = (Init init) {
	var func (int, out bool) f2 = gt3
	var bool big = f2(5)
	Console.write("big=\\{big}\\n")
	var func (string, out int) f3 = len_of
	var int n = f3("abcd")
	Console.write("n=\\{n}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "funcval_out_return", "big=true\nn=4\ndone\n", true);
	});

	test("reassignment swaps the target; mismatched signature rejected", async () => {
		// valid reassignment runs
		const ok_input = `
import System

func gt3 = (int i, out bool) => i > 3
func gt10 = (int i, out bool) => i > 10

pub func main = (Init init) {
	var func (int, out bool) f = gt3
	var bool a = f(5)
	f = gt10
	var bool b = f(5)
	Console.write("a=\\{a} b=\\{b}\\n")
	Console.write("done\\n")
}
`;
		expect(parse_raw(ok_input).errors).toEqual([]);
		await build_and_check_output(ok_input, "funcval_reassign", "a=true b=false\ndone\n", true);

		// mismatched signature is rejected at check time
		const bad_input = `
import System

func gt3 = (int i, out bool) => i > 3
func wrong = (string s, out bool) => s.length > 3

pub func main = (Init init) {
	var func (int, out bool) f = gt3
	f = wrong
	Console.write("done\\n")
}
`;
		expect(
			parse_raw(bad_input).errors.some((e) => e.message.includes("Function signature mismatch")),
		).toBe(true);
	});
});
