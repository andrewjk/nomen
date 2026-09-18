import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A `const <name> = <literal>` local inside a function is lowered by the
// aarch64 backend as a FILE-SCOPE `.quad` label named after the variable —
// not as a stack slot. Two functions that each declare a same-named const
// local therefore collide at assembly time ("symbol 'z' is already
// defined"), and even a single such function can collide with a user global
// of the same name. The C backend lowers the same program correctly.
//
// Found by the differator port: `span_of_group` and `group_first_moved`
// both used `const z = 0` as a literal-0 stand-in for a bounds-guarded
// `.at(z)` (the bounds checker rejects `.at(0)` on a runtime-length list),
// and `nomen test --arch aarch64` failed to assemble the test binary.

describe("const local with literal initializer: remaining gaps", () => {
	test("same-named const locals in two functions must not collide at assembly", async () => {
		const input = `import System

func first_zero = (int n, out int) {
	const z = 0
	if z < n {
		return 100 + z
	}
	return z
}

func second_zero = (int n, out int) {
	const z = 0
	if z < n {
		return 200 + z
	}
	return z
}

pub func main = () {
	Console.write_line("\\{first_zero(1)} \\{second_zero(1)}")
}
`;
		await build_and_check_output(input, "gap_const_local_collision", "100 200\n", true);
	});
});
