import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// The C backend's class-alias bookkeeping (c_alias_owns_flags and its sibling
// maps) is keyed by bare variable name but used to persist across function
// boundaries, while the emitted `int _alias_owns_<name> = 0;` declarations
// live in the function that registered them. An unrelated same-named variable
// in a LATER function then had its scope-exit destroy guarded by a flag that
// was never declared in that function's scope — an undeclared-identifier
// compile error. Variables cannot be shared across functions, so the maps are
// now reset per function. Before the fix this pair of functions failed to
// compile on the C backend (main's `t` picks up first()'s leaked flag); the
// aarch64 backend was unaffected.

describe("C backend: alias-own flags are per-function", () => {
	test("borrow in one function does not guard a later function's owned variable", async () => {
		const input = `
import System

class R {
	var int v
}
func first = (List<R> xs, out int) {
	if xs.length > 0 {
		const R t = xs.at(0)
		return t.v
	}
	return 0
}
pub func main = (Init init) {
	var List<R> xs = List<R>()
	var a = R(7)
	xs.push(mov a)
	var t = R(41)
	Console.write("\\{first(xs)} \\{t.v}\\n")
}
`;
		await build_and_check_output(input, "alias_flag_cross_function", "7 41\n", true);
	});
});
