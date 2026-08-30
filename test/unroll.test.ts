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

test("fixed-trip inner loop unrolls; outer with nested body stays a loop", () => {
	const code = compile(KERNEL);
	const fn = code.slice(code.indexOf("kernel:"), code.indexOf("main:"));
	// The outer body contains the nested inner loop → kept as a loop (the
	// clang shape: outer looped, inner fully unrolled). Exactly one loop.
	const loops = (fn.match(/\.while_\d+:/g) ?? []).length;
	expect(loops).toBe(1);
	// 5 × 7 FP ops of straight-line inner chain.
	const fp = (fn.match(/^\s*f(mul|add|sub)/gm) ?? []).length;
	expect(fp).toBeGreaterThanOrEqual(35);
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
