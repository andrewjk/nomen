import { describe, expect, test } from "vite-plus/test";

import build, { default_platform } from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// "Field of a call-result struct" fixes (FOLLOWUP, recorded while landing the
// add/alloc tranche):
//
// 1. `container.at_or(i, fallback).name` — a string field read off an
//    `at_or` result. `at_or` was missing from the borrow-accessor family, so
//    the receiver hoist bound the aliasing result as an OWNING temp and its
//    scope-exit destroy freed the container's slot string (double free).
//    `at_or` returns `self.at(i)` or the caller's own fallback temp — both
//    non-owning — so it joins the family alongside `get_or`.
// 2. `total = m.get_or(k, make(x)).n` — a receiver temp whose call has a
//    hoisted `_param_N` argument emitted the argument's declaration inside
//    the receiver's initializer (`struct Rec _recv_1 = unsigned char
//    _mv_owns__param_0 = 0; ...`), invalid C. Nested value allocations now
//    surface before their host.

describe("string field read off a call-result struct", () => {
	const rec_program = (body: string): string => `
import System

mv struct Rec {
	var name = ""
	var int n = 0
}

func make = (int i, out Rec) {
	var r = Rec()
	r.name = "v" + i.to_string()
	r.n = i
	return r
}

pub func main = (Init init) {
${body}
}
`;

	test("at_or's string field read aliases the slot (no double free)", async () => {
		const input = rec_program(`
	var xs = List<Rec>()
	xs.push(make(1))
	xs.push(make(2))
	Console.write(xs.at_or(1, Rec()).name)
	Console.write("|")
	Console.write(xs.at_or(9, Rec()).name)
	Console.write("\\n")
`);
		await build_and_check_output(input, "call_result_field_at_or", "v2|\n", true);
	});

	test("get_or's string field read aliases the slot (no double free)", async () => {
		const input = rec_program(`
	var m = Map<int, Rec>()
	m.set(1, make(3))
	Console.write(m.get_or(1, make(0)).name)
	Console.write("|")
	Console.write(m.get_or(9, make(0)).name)
	Console.write("\\n")
`);
		await build_and_check_output(input, "call_result_field_get_or", "v3|v0\n", true);
	});

	test("a declared at_or binding keeps the slot string owned by the container", async () => {
		const input = rec_program(`
	var xs = List<Rec>()
	xs.push(make(1))
	xs.push(make(2))
	var got = xs.at_or(1, Rec())
	Console.write(got.name)
	Console.write(" ")
	Console.write(xs.at_or(1, Rec()).n.to_string())
	Console.write("\\n")
`);
		await build_and_check_output(input, "call_result_field_at_or_decl", "v2 2\n", true);
	});

	test("a hoisted argument inside an assignment-position receiver compiles and runs", async () => {
		const input = rec_program(`
	var total = 0
	var m = Map<int, Rec>()
	m.set(1, make(1))
	total = m.get_or(1, make(0)).n
	Console.write(total.to_string())
	Console.write("\\n")
`);
		await build_and_check_output(input, "call_result_field_hoist_arg", "1\n", true);
	});

	test("the hoisted argument is emitted before its receiver temp", async () => {
		const input = rec_program(`
	var total = 0
	var m = Map<int, Rec>()
	m.set(1, make(1))
	total = m.get_or(1, make(0)).n
	Console.write(total.to_string())
`);
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: default_platform() });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		const arg_at = code.indexOf("struct Rec _param_0 = make(0L);");
		const recv_at = code.indexOf("struct Rec _recv_1 = Map_int_Rec_get_or(");
		expect(arg_at).toBeGreaterThan(0);
		expect(recv_at).toBeGreaterThan(arg_at);
		// The receiver declaration is never the argument declaration's text.
		expect(code).not.toContain("_recv_1 = unsigned char");
	});
});
