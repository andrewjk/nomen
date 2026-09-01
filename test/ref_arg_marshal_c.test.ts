import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

/**
 * Scalar `ref` arguments through the C backend's METHOD-call path lost their
 * address-of: build_access_node's argument loop only emitted `&` inside the
 * struct/trait branch, so a `ref int` param (lowered to `long *r`) received
 * the raw value — clang rejected with -Wint-conversion. Free-function calls
 * (build_function_call_node) always staged `&` correctly; the aarch64 backend
 * stages `&slot` through its arg loop's ref branch.
 *
 * The interpolation shape additionally exercises the checker's hoisted
 * `_param_N` temp (`int_to_string(Counter_take(c, &box))`).
 */

const SRC = `
import System

class Counter {
	var int n
	func take = (ref self, ref int r, out int) {
		r = r + 1
		return self.n
	}
}

pub func main = () {
	var Counter c = Counter(0)
	var int box = 41
	c.take(ref box)
	Console.write("\\{box} ")
	var int box2 = 9
	Console.write("\\{c.take(ref box2)}\\{box2}\\n")
}
`;

test("scalar ref method args marshal with & on C (statement + hoisted)", async () => {
	await build_and_check_output(SRC, "ref_arg_marshal_c", "42 010", true);
});
