import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Buffer bounds checking: load_int/store_int have an `i >= 0 && i < self.cap`
// constraint. The compiler verifies this at compile time via flow analysis
// (e.g. cap tracked from grow_int, alias tracking for `var int c = buf.get_cap()`,
// post-loop bounds). There is no runtime clamp — out-of-bounds access is a
// compile error when provable.

describe("buffer bounds checking", () => {
	test("negative constant index is caught at compile time", () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(4)
buf.store_int(0, 111)
var int neg = buf.load_int(-1)
Console.write("\\{neg}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	test("index past capacity is caught at compile time", () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(4)
buf.store_int(0, 111)
var int past = buf.load_int(100)
Console.write("past=\\{past}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	test("write past capacity is caught at compile time", () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(2)
buf.store_int(0, 11)
buf.store_int(1, 22)
buf.store_int(5, 999)
Console.write("\\{buf.load_int(0)}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	test("verifiable in-bounds access compiles clean", async () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(4)
buf.store_int(0, 111)
buf.store_int(1, 222)
buf.store_int(2, 333)
buf.store_int(3, 444)
var int a = buf.load_int(0)
var int b = buf.load_int(3)
Console.write("\\{a} \\{b}\\n")
`;
		await build_and_check_output(input, "oob_in_bounds", "111 444\n");
	});

	test("runtime index inside `if i < cap` verifies", async () => {
		const input = `
var Buffer<int> buf = Buffer<int>()
buf.grow_int(4)
buf.store_int(0, 10)
buf.store_int(1, 20)
buf.store_int(2, 30)
buf.store_int(3, 40)
var int i = 0
var int sum = 0
while i < buf.cap {
	sum = sum + buf.load_int(i)
	i = i + 1
}
Console.write("\\{sum}\\n")
`;
		await build_and_check_output(input, "oob_runtime_bounded", "100\n");
	});
});

// Buffer OOB gap: previously the verifier silently allowed unverifiable
// `Buffer.load_int`/`store_int` index constraints (the `silent_core` carve-out
// in check_function_call.ts). The `cap` field on Buffer is a normal `pub`
// property, so user code can — and must — guard runtime indices with
// `if i < buf.cap` (or a hoisted loop bound). These tests pin the
// requirement: an index whose bound against `buf.cap` cannot be proven is
// now a compile error, not a silent trust-me.
describe("unverifiable buffer index is rejected (no silent_core carve-out)", () => {
	test("load_int(slot_count) where slot_count == cap is rejected", () => {
		const input = `
var int slot_count = 10
var Buffer<int> flags = Buffer<int>()
flags.alloc_int(slot_count)
var int x = flags.load_int(slot_count)
Console.write("\\{x}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	test("while i <= slot_count lets i reach cap (off-by-one) is rejected", () => {
		const input = `
var int slot_count = 10
var Buffer<int> flags = Buffer<int>()
flags.alloc_int(slot_count)
var int i = 0
var int sum = 0
while i <= slot_count {
	sum = sum + flags.load_int(i)
	i = i + 1
}
Console.write("\\{sum}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});

	test("for i of 0 .. n with n > cap is rejected (needs a guard)", () => {
		// `n` is a runtime value unrelated to the buffer's allocation, so the
		// verifier cannot prove `i < flags.cap` for `i` drawn from `0 .. n`.
		// The programmer must guard: `if n <= flags.cap { for i of 0 .. n { ... } }`.
		const input = `
var Buffer<int> flags = Buffer<int>()
flags.alloc_int(10)
var int n = 100
for i of 0 .. n {
	Console.write("\\{flags.load_int(i)}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});

	test("nsieve-style loop with slot derived from a runtime n is rejected", () => {
		// The slot index `i >> 6` is not provably < flags.cap when `n` is
		// a runtime value unrelated to the buffer's allocation. The
		// programmer must hoist a guard: `if (n - 1) >> 6 < flags.cap { ... }`.
		const input = `
var int slot_count = 10
var Buffer<int> flags = Buffer<int>()
flags.alloc_int(slot_count)
var int n = 100
var int i = 3
while i < n {
	var int slot = i >> 6
	if (flags.load_int(slot) & 1) == 0 {
		Console.write("x")
	}
	i = i + 2
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});

	test("runtime index guarded by `if i < buf.cap` is accepted", () => {
		const input = `
var int slot_count = 10
var Buffer<int> flags = Buffer<int>()
flags.alloc_int(slot_count)
var int i = 0
while i < 100 {
	if i < flags.cap {
		Console.write("\\{flags.load_int(i)}")
	}
	i = i + 1
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("runtime upper bound hoisted once outside the loop is accepted", () => {
		// Hoisting the guard outside the loop is the performant escape
		// hatch: check the loop's upper bound against `flags.cap` once,
		// then the inner loop's load_int is provably in bounds because
		// `i < n` and `n <= flags.cap` together imply `i < flags.cap`.
		const input = `
var int slot_count = 10
var Buffer<int> flags = Buffer<int>()
flags.alloc_int(slot_count)
var int n = 8
if n <= flags.cap {
	var int i = 0
	while i < n {
		Console.write("\\{flags.load_int(i)}")
		i = i + 1
	}
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});
