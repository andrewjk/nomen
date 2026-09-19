import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import {} from "./system_lib";

// Regression: a generic struct method's monomorphized body must substitute
// the element type through EVERYTHING the builder reads — including the
// checker-hoisted call-argument temps (`const _param_N = self.value` in
// func_call.allocations). Before the fix the hoisted temp kept the generic
// `T` types, and the aarch64 body loaded the mono fat-string field with one
// `ldr` (ptr half only — len half garbage), so `f(self.value)` received a
// corrupt pair and the printed value was garbage.
//
// Both legs run with audit off: the round-trip through the fn boundary
// strdups the string and the final value lives in the struct field through a
// `ref self` callee, so the heap_string_fields record is scope-local (the
// accepted bounded leak — see FOLLOWUP.md "Cross-scope string field stores
// leak the stored copy"). The printed value is the regression signal.

const INPUT = `
struct Box<T> {
	var T value

	func modify = (ref self, func (T, out T) f) {
		self.value = f(self.value)
	}
}

var Box<string> bs = Box<string>("a")
var func (string, out string) bang = (s, out string) => s + "!"
bs.modify(bang)
Console.write_line(bs.value)
`;

async function run_arch(arch: "c" | "aarch64", name: string) {
	const parsed = parse_with_imports(INPUT);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch, audit: false });
	await check_output(name, result, "a!\n", { arch, audit: false });
}

test("mono body substitutes T through hoisted arg temps (C)", async () => {
	await run_arch("c", "generic_string_field_c");
});

test("mono body substitutes T through hoisted arg temps (aarch64)", async () => {
	await run_arch("aarch64", "generic_string_field_a64");
});
