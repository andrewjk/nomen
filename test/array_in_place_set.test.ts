import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// PERF_PLAN item 17 (minor batch): Array<T>.set for strings did
// `free(old); strdup(new)` per store, and a producer argument was hoisted into
// a `_param_N` temp first (strdup into the slot + temp free). The in-place
// store contract now covers heap Array<T> receivers: `arr.set(i, f(x))`
// constructs f(x)'s result straight into element i — the displaced element is
// reclaimed through the slot (string free + pair zero), then the producing
// call writes the slot; no temp, no second strdup. The element address is
// computed inline by both backends (a heap array's local holds the block
// pointer; the elements follow the length word). Pinned at the runtime level
// (both backends, audit on) and at the emitted-code level.

function build_aarch64(source: string): string {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "aarch64", audit: false }).code;
}

function build_c(source: string): string {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "c", audit: false }).code;
}

const PROGRAM = `
func make = (int i, out string) {
	return "m\\{i}"
}
var arr = Array.with("seed", 6)
var i = 0
while i < arr.length; i += 1 {
	arr.set(i, make(i))
}
var j = 0
while j < arr.length; j += 1 {
	Console.write(arr.at(j))
	Console.write(" ")
}
Console.write("\\n")
// Non-stamped control: a borrowed local keeps the ordinary set path.
var taken = "taken"
arr.set(2, taken)
Console.write("\\{arr.at(2)} \\{arr.length}\\n")
`;

describe("Array.set in-place producer store", () => {
	test("a producer call constructs straight into the array slot", async () => {
		// Six producer stores through the stamped path, then one borrowed
		// local through the ordinary deep-copy path.
		await build_and_check_output(PROGRAM, "array_in_place_set", "m0 m1 m2 m3 m4 m5 \ntaken 6\n");
	});

	test("the aarch64 set splice computes the slot inline and calls the producer", () => {
		const code = build_aarch64(PROGRAM);
		// The stamped splice's element address: a 16-byte stride madd (fat
		// string element), no Array slot primitive call exists.
		expect(code).toContain("madd x0, x1, x3, x0");
		expect(code).not.toContain("Array_string_slot_ptr");
		// The producer runs at the store site; the displaced value is
		// reclaimed first (free + zero pair) and the produced pair lands in
		// the slot — no hoisted temp strdup.
		const start = code.indexOf("bl main_make");
		expect(start).toBeGreaterThan(-1);
		const before = code.slice(Math.max(0, start - 400), start);
		expect(before).toContain("stp xzr, xzr, [x10]");
		const after = code.slice(start, start + 120);
		expect(after).toContain("str x0, [x10]");
		expect(after).toContain("str x1, [x10, #8]");
	});

	test("the C set splice assigns the producer result to the slot", () => {
		const code = build_c(PROGRAM);
		expect(code).toContain(
			"nomen_string* _nomen_islot = ((nomen_string*)((char*)arr + sizeof(struct Array_string))) + (i);",
		);
		expect(code).toContain("free(_nomen_islot->ptr);");
		expect(code).toContain("*_nomen_islot = main_make(i);");
	});
});
