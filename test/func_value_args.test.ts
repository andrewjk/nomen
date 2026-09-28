import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Func-typed VALUES (params/fields/locals) are called through the closure
// descriptor ABI: env in x0, then the visible args. Two aarch64 bugs lived in
// that marshal path — (1) multi-arg calls assigned slots in evaluation order
// rather than positionally (so `f(10, 3)` computed `3 - 10`), and (2) args
// beyond the 8 register slots were never placed in the outgoing stack-arg area
// (`mov undefined, x0`, then a bad frame for a normalizing named-function
// thunk). Both are fixed; these lock the behavior down.

describe("func-value argument marshalling", () => {
	test("a func value called through its descriptor gets positional args", async () => {
		await build_and_check_output(
			`
import System

struct Runner {
	func run = (self, func (int, int, out int) f, out int) { return f(10, 3) }
}

pub func main = () {
	var Runner r = Runner()
	Console.write_line(r.run((a, b, out int) => a - b).to_string())
}
`,
			"funcval_args_positional",
			"7\n",
			true,
		);
	});

	test("a named function value with more than 8 int args is callable", async () => {
		await build_and_check_output(
			`
import System

func sum9 = (int a, int b, int c, int d, int e, int f0, int g, int h, int i, out int) {
	return a + b + c + d + e + f0 + g + h + i
}

pub func main = () {
	var func (int, int, int, int, int, int, int, int, int, out int) f = sum9
	Console.write_line(f(1, 2, 3, 4, 5, 6, 7, 8, 9).to_string())
}
`,
			"funcval_args_overflow_int",
			"45\n",
			true,
		);
	});

	test("a named function value with a string arg past the registers is callable", async () => {
		await build_and_check_output(
			`
import System

func pick = (int a, int b, int c, int d, int e, int f0, int g, int h, string s, out string) {
	return s
}

pub func main = () {
	var func (int, int, int, int, int, int, int, int, string, out string) f = pick
	Console.write_line("\\{f(1, 2, 3, 4, 5, 6, 7, 8, "ok") + "!"}")
}
`,
			"funcval_args_overflow_string",
			"ok!\n",
			true,
		);
	});
});
