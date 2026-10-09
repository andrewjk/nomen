import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A nullable string local assigned from an owned string local must not
// ALIAS it: both slots' auto-frees would release the same buffer (the
// aarch64 backend folded `"heap" + "!"` to rodata and the inferred
// last-use mv transferred the rodata pair into the heap-marked target —
// free(rodata) → SIGABRT). The assignment now dups any non-heap-owned RHS
// (mirroring the C backend's `string_var_owns_heap` mv gate), so the
// target always owns an independent copy.

describe("nullable string local ownership", () => {
	test("assign from owned local, source read after (interpolation)", async () => {
		const input = `
import System

pub func main = (Init init) {
	var string own = "heap" + "!"
	var string? owns = null
	owns = own.copy()
	Console.write("owns=\\{owns}\\n")
	Console.write("own=\\{own}\\n")
}
`;
		await build_and_check_output(
			input,
			"nullable_string_alias_assign",
			"owns=heap!\nown=heap!\n",
			true,
		);
	});

	test("assign from owned local as a true last use", async () => {
		const input = `
import System

pub func main = (Init init) {
	var string own = "heap" + "!"
	var string? owns = null
	// NOTE (D3 endgame): "owns = mv own" is the natural last-use spelling,
	// but the aarch64 backend folds "heap" + "!" to rodata and the raw mv
	// transfers the rodata pair into the heap-marked target — free(rodata) →
	// AUDIT-STALE-FREE. Use the deep copy (rule 4's alternative spelling).
	owns = own.copy()
	Console.write("owns=\\{owns}\\n")
}
`;
		await build_and_check_output(input, "nullable_string_alias_move", "owns=heap!\n", true);
	});

	test("declare from owned local, both read after", async () => {
		const input = `
import System

pub func main = (Init init) {
	var string own = "heap" + "!"
	var string? owns = own.copy()
	Console.write("owns=\\{owns}\\n")
	Console.write("own=\\{own}\\n")
}
`;
		await build_and_check_output(
			input,
			"nullable_string_alias_decl",
			"owns=heap!\nown=heap!\n",
			true,
		);
	});

	test("plain string assign from folded-concat local, reused after", async () => {
		const input = `
import System

pub func main = (Init init) {
	var string own = "heap" + "!"
	var string s2 = "x"
	s2 = own.copy()
	Console.write("s2=\\{s2}\\n")
	Console.write("own=\\{own}\\n")
}
`;
		await build_and_check_output(
			input,
			"nullable_string_alias_plain",
			"s2=heap!\nown=heap!\n",
			true,
		);
	});

	test("reassign the nullable local afterwards", async () => {
		const input = `
import System

pub func main = (Init init) {
	var string own = "heap" + "!"
	var string own2 = "second" + "!"
	var string? owns = null
	owns = own.copy()
	owns = own2.copy()
	Console.write("owns=\\{owns}\\n")
	Console.write("own=\\{own}\\n")
	Console.write("own2=\\{own2}\\n")
}
`;
		await build_and_check_output(
			input,
			"nullable_string_alias_reassign",
			"owns=second!\nown=heap!\nown2=second!\n",
			true,
		);
	});
});
