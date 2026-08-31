import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_loop_unrolling_enabled } from "../src/build_aarch64/unroll";

// The unroller ships default-off (pending ASM_PLAN_2 tranche B); these tests
// exercise it explicitly.
set_loop_unrolling_enabled(true);
import { parse_raw } from "./parse_with_imports";

/**
 * Full unrolling of fixed-trip loops (ASM_PLAN_2 tranche A): `while i < B`
 * with B an integer literal, a 0-init/+1-step induction the body never
 * reads, and no break/continue at this level → the loop machinery is
 * deleted and the body is emitted B straight times. Everything else keeps
 * its loop.
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const KERNEL = `
import System

func kernel = (float cr, float ci, out int) {
	var zr = 0.0
	var zi = 0.0
	var tr = 0.0
	var ti = 0.0
	var outer = 0
	while outer < 10; outer += 1 {
		var inner = 0
		while inner < 5; inner += 1 {
			zi = (zr + zr) * zi + ci
			zr = tr - ti + cr
			tr = zr * zr
			ti = zi * zi
		}
		if tr + ti > 4.0 {
			return 0
		}
	}
	return 1
}
pub func main = () {}
`;

test("mandelbrot kernel composes: both loops unroll", () => {
	const code = compile(KERNEL);
	const fn = code.slice(code.indexOf("kernel:"), code.indexOf("main:"));
	// Outer-first composition (tranche E addendum): the inner's init is a
	// literal 0, so it plans under every outer copy → both loops are gone.
	const loops = (fn.match(/\.while_\d+:/g) ?? []).length;
	expect(loops).toBe(0);
	// 10 × 5 × 4 FP ops of straight-line inner chain.
	const fp = (fn.match(/^\s*f(mul|add|sub)/gm) ?? []).length;
	expect(fp).toBeGreaterThanOrEqual(35);
});

test("outer with a non-plannable nested body stays a loop", () => {
	const code = compile(`
import System

func kernel = (int n, out int) {
	var zr = 0.0
	var zi = 0.0
	var outer = 0
	while outer < 10; outer += 1 {
		var inner = 0
		while inner < n; inner += 1 {
			zi = (zr + zr) * zi + 1.0
			zr = zr * zr
		}
	}
	return 1
}
pub func main = () {}
`);
	// The inner's bound is a param → it never plans → the composition gate
	// keeps the outer a loop too (the clang shape: outer looped).
	const fn = code.slice(code.indexOf("kernel:"), code.indexOf("main:"));
	expect((fn.match(/\.while_\d+:/g) ?? []).length).toBe(2);
});

test("induction-index reads unroll with constant substitution", () => {
	const code = compile(`
import System

pub func main = () {
	var b = Buffer<float>()
	b.alloc_float(8)
	if b.cap >= 8 {
		var i = 0
		while i < 8; i += 1 {
			b.store_float(i, 1.0)
		}
	}
}
`);
	// Loop machinery gone; the copies store with constant indices.
	const fn = code.slice(code.indexOf("pub func main"), code.length);
	expect(fn).not.toContain(".while_");
});

test("non-literal bound keeps the loop", () => {
	const code = compile(`
import System

func f = (int n) {
	if n >= 1 {
		var i = 0
		while i < n; i += 1 {
			var int x = 0
		}
	}
}
pub func main = () {}
`);
	expect(code).toContain(".while_");
});

test("break at this loop level keeps the loop", () => {
	const code = compile(`
import System

func f = () {
	var i = 0
	while i < 8; i += 1 {
		if i == 3 {
			break
		}
	}
}
pub func main = () {}
`);
	expect(code).toContain(".while_");
});

test("break inside a NESTED loop keeps both loops looping", () => {
	const code = compile(`
import System

func f = (out int) {
	var i = 0
	while i < 4; i += 1 {
		var j = 0
		while j < 3; j += 1 {
			if j == 1 {
				break
			}
			j += 1
		}
	}
	return 7
}
pub func main = () {}
`);
	// Outer contains a nested loop → outer stays; the inner's own break
	// rejects the inner's unroll → both remain loops (two end labels).
	const fn = code.slice(code.indexOf("f:"), code.indexOf("main:"));
	expect((fn.match(/\.end_while_\d+:/g) ?? []).length).toBe(2);
});

test("non-scalar declaration keeps the loop", () => {
	const code = compile(`
import System

func f = () {
	var i = 0
	while i < 4; i += 1 {
		var string s = "x"
	}
}
pub func main = () {}
`);
	expect(code).toContain(".while_");
});

test("default is off; kill-switch restores the loop emission", () => {
	set_loop_unrolling_enabled(false);
	try {
		const code = compile(KERNEL);
		expect(code).toContain(".while_");
	} finally {
		set_loop_unrolling_enabled(true);
	}
});

test("behavioral: unrolled recurrence chains print exact results", async () => {
	// x = x*2 + 1 five times from x=0 → 31; nested 3×2 grid of the same →
	// deterministic; both shapes ride the unrolled path.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func chain = (out float) {
	var x = 0.0
	var i = 0
	while i < 5; i += 1 {
		x = x * 2.0 + 1.0
	}
	return x
}

func grid = (out float) {
	var x = 0.0
	var outer = 0
	while outer < 3; outer += 1 {
		var inner = 0
		while inner < 2; inner += 1 {
			x = x + 0.5
		}
	}
	return x
}
pub func main = () {
	Console.write("\\{chain()} \\{grid()}")
}
`,
		"unroll_chain",
		"31.000000 3.000000",
		true,
	);
});

test("comparison must be `<` — count-down shapes keep their loop", () => {
	const code = compile(`
import System

func f = (out int) {
	var i = 0
	while i > 5; i += 1 {
		var int x = 0
	}
	return 1
}
pub func main = () {}
`);
	// The trip-count arithmetic is bound - init — a `>` bound would have
	// miscompiled into 5 copies of a loop that never runs.
	const fn = code.slice(code.indexOf("f:"), code.indexOf("main:"));
	expect(fn).toContain(".while_");
});

test("non-zero literal init unrolls with per-copy constants", () => {
	const code = compile(`
import System

func f = (out float) {
	var acc = 0.0
	var i = 2
	while i < 5; i += 1 {
		acc = acc + i as float
	}
	return acc
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("f:"), code.indexOf("main:"));
	// Trips 2, 3, 4 — the plan's init is the literal, not just 0.
	expect(fn).not.toContain(".while_");
	expect((fn.match(/mov x0, #[234]\n/g) ?? []).length).toBeGreaterThanOrEqual(3);
});

test("zero-trip loop unrolls to the post-loop store only", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func f = (out int) {
	var i = 5
	while i < 5; i += 1 {
		var int x = 0
	}
	return i
}
pub func main = () {
	Console.write("\\{f()}")
}
`,
		"unroll_zero_trip",
		"5",
		true,
	);
});

test("composition: outer index-constant unroll constant-folds the inner init", () => {
	const code = compile(`
import System

func kernel = (out float) {
	var acc = 0.0
	var i = 0
	while i < 3; i += 1 {
		var int j = i + 1
		while j < 3; j += 1 {
			acc = acc + i as float * 10.0 + j as float
		}
	}
	return acc
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("kernel:"), code.indexOf("main:"));
	// `j = i + 1` resolves per outer copy (k+1) → the inner plans under
	// every copy → both loops are gone.
	expect(fn).not.toContain(".while_");
});

test("behavioral: composed double loop prints exact pair sums (incl. zero-trip copy)", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func pairs = (out float) {
	var acc = 0.0
	var i = 0
	while i < 4; i += 1 {
		var int j = i + 1
		while j < 4; j += 1 {
			acc = acc + i as float * 10.0 + j as float
		}
	}
	return acc
}
pub func main = () {
	Console.write("\\{pairs()}")
}
`,
		"unroll_compose",
		"54.000000",
		true,
	);
});

test("composition gate: non-constant inner init keeps both loops", () => {
	const code = compile(`
import System

func f = (int n, out int) {
	var i = 0
	while i < 3; i += 1 {
		var int j = n + 1
		while j < 3; j += 1 {
			var int x = 0
		}
	}
	return 1
}
pub func main = () {}
`);
	// `j = n + 1` never resolves (n is a param) → the inner rejects under
	// every copy → the outer rejects too. Both stay loops.
	const fn = code.slice(code.indexOf("f:"), code.indexOf("main:"));
	expect((fn.match(/\.while_\d+:/g) ?? []).length).toBe(2);
});

test("composition gate: inner break at its own level keeps both loops", () => {
	const code = compile(`
import System

func f = (out int) {
	var i = 0
	while i < 3; i += 1 {
		var int j = i + 1
		while j < 3; j += 1 {
			if j == 1 {
				break
			}
		}
	}
	return 1
}
pub func main = () {}
`);
	// The break targets the inner loop; unrolling the inner would delete
	// its target, and the outer inherits the rejection via the gate.
	const fn = code.slice(code.indexOf("f:"), code.indexOf("main:"));
	expect((fn.match(/\.while_\d+:/g) ?? []).length).toBe(2);
});
