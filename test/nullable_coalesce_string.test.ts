import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `nullable ?? "literal"` on C yielded the chosen branch DIRECTLY, and the
// freeing consumer (interpolation-arg wrapper, let binding) freed it: a
// rodata literal free → SIGABRT, and a non-null left aliased the payload
// into the result (double free at the left's own scope exit). The `??`
// string result is now dup'd into an independently owned copy on both
// branches (nomen_str_dup — the prelude helper, null-safe).

describe("nullable string ?? fallback", () => {
	test("fallback branch feeds interpolation, let, and return", async () => {
		const input = `
import System

func probe = (string? p, out string) {
	var s = p ?? "none"
	return s
}

pub func main = (Init init) {
	var string? p = null
	Console.write("a=\\{p ?? "none"}\\n")
	Console.write("b=\\{probe(null)}\\n")
	var string q = p ?? "fallback"
	Console.write("c=\\{q}\\n")
}
`;
		await build_and_check_output(
			input,
			"nullable_coalesce_fallback",
			"a=none\nb=none\nc=fallback\n",
			true,
		);
	});

	test("non-null branch result is independently owned", async () => {
		const input = `
import System

pub func main = (Init init) {
	var string? lit = "lit"
	var string s1 = lit ?? "none"
	Console.write("s1=\\{s1}\\n")
	Console.write("lit=\\{lit ?? "unset"}\\n")
}
`;
		await build_and_check_output(input, "nullable_coalesce_nonnull", "s1=lit\nlit=lit\n", true);
	});
});
