import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression tests for `Buffer<float>` load_float / store_float inlined
// fast paths (build_access_node.ts). Two pre-existing bugs were fixed:
//
// 1. `load_float` left its result in `d0` but did not emit `fmov x0, d0`,
//    so consumers that expect the default x0 convention (assignments, float
//    operation operands via `build_float_operand`, comparisons, statement-
//    level expressions) read a stale x0 (often the index register) and
//    silently produced `nan`. This was the spectral-norm `nan` bug.
//
// 2. `store_float` stored from `d0` (whatever stale float a prior op left
//    behind) instead of from `x2`, where the value bit pattern actually
//    landed after the fast path's `mov x2, x0`. This was a latent bug
//    masked by d0 usually happening to still hold the right value.

describe("Buffer<float> load_float / store_float fast paths", () => {
	test("load_float used in a float expression produces correct result", async () => {
		// Directly exercises the load_float → build_float_operand path that
		// produced `nan` before the fix: the loaded value feeds a float
		// multiply, whose result is then assigned.
		const input = `
var Buffer<float> buf = Buffer<float>()
buf.alloc_float(4)
buf.store_float(0, 1.5)
buf.store_float(1, 2.0)
buf.store_float(2, 0.5)
buf.store_float(3, 3.0)
var float a = buf.load_float(0) * buf.load_float(1)
var float b = buf.load_float(2) + buf.load_float(3)
Console.write("\\{a} \\{b}\\n")
`;
		await build_and_check_output(input, "float_buf_expr", "3.000000 3.500000\n");
	});

	test("store_float persists the correct value (not a stale d0)", async () => {
		// The store_float fast path was storing from d0 instead of x2. With
		// interleaved integer work between the float computation and the
		// store, d0 would be stale — this catches that by doing integer
		// arithmetic between computing the value and storing it.
		const input = `
var Buffer<float> buf = Buffer<float>()
buf.alloc_float(3)
var int n = 0
buf.store_float(0, 1.0)
n = n + 1
buf.store_float(1, 2.5)
n = n + 1
buf.store_float(2, 4.25)
n = n + 1
Console.write("\\{buf.load_float(0)} \\{buf.load_float(1)} \\{buf.load_float(2)} \\{n}\\n")
`;
		await build_and_check_output(input, "float_buf_store", "1.000000 2.500000 4.250000 3\n");
	});

	test("spectral-norm-style accumulation over a float buffer", async () => {
		// Mirrors the spectral-norm hot loop: accumulate a sum of products
		// where each factor is a load_float. This was the exact pattern
		// that produced `nan` before the fix.
		const input = `
var Buffer<float> u = Buffer<float>()
var Buffer<float> v = Buffer<float>()
u.alloc_float(5)
v.alloc_float(5)
var int i = 0
while i < 5 {
	u.store_float(i, (i + 1) as float)
	v.store_float(i, (i + 2) as float)
	i = i + 1
}
var float dot = 0.0
i = 0
while i < 5 {
	dot = dot + u.load_float(i) * v.load_float(i)
	i = i + 1
}
Console.write("\\{dot}\\n")
`;
		await build_and_check_output(input, "float_buf_dot", "70.000000\n");
	});

	test("load_float as a direct statement-level value", async () => {
		// load_float assigned directly to a float var (not inside a float op)
		// must also produce the right value — the fast path must emit
		// `fmov x0, d0` when the caller is not a float operation.
		const input = `
var Buffer<float> buf = Buffer<float>()
buf.alloc_float(3)
buf.store_float(0, 1.1)
buf.store_float(1, 2.2)
buf.store_float(2, 3.3)
var float x = buf.load_float(1)
Console.write("\\{x}\\n")
`;
		await build_and_check_output(input, "float_buf_load_direct", "2.200000\n");
	});
});
