import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Struct-returning functions corrupted params/locals after calls:
//   - `return R(a, b)` (a struct constructor) stored its string arguments raw,
//     but the callee's scope-exit reclaim freed a heap local whose bytes the
//     returned field still borrowed — a use-after-free ("read back
//     corrupted"). The return boundary now normalizes constructor returns.
//   - C freed a `var string t = param` local without dup'ing it, releasing the
//     caller's storage. Such a borrow-initialized local is now borrow-only.
// Covered on both backends with the audit allocator on.

describe("struct-returning functions and string params/locals", () => {
	test("constructor return with a heap local string", async () => {
		const input = `
struct R {
	var int a
	var string b
}

func no_loop = (string s, out R) {
	var out_s = s
	return R(1, out_s)
}

func with_call = (string s, out R) {
	var out_s = s.to_string()
	return R(1, out_s)
}

var a = no_loop("xy")
Console.write("no_loop a=\\{a.a} b=\\{a.b}\\n")
var b = with_call("xy")
Console.write("with_call a=\\{b.a} b=\\{b.b}\\n")
`;
		await build_and_check_output(
			input,
			"struct_return_string_local",
			"no_loop a=1 b=xy\nwith_call a=1 b=xy\n",
		);
	});

	test("string local initialized from a parameter survives scope exit", async () => {
		const input = `
func f = (string s, out int) {
	var t = s
	var u = t
	Console.write("t=\\{t} u=\\{u}\\n")
	return t.length
}

Console.write("r=\\{f("hi")}\\n")
`;
		await build_and_check_output(input, "string_local_from_param", "t=hi u=hi\nr=2\n");
	});
});
