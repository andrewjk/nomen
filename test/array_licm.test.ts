import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_array_licm_enabled } from "../src/build_aarch64/array_licm";
import { parse_raw } from "./parse_with_imports";

/**
 * Fixed-array element-address pipeline (ASM_PLAN_3 tranche A): `.at(i).field`
 * on a fixed-size array of structs pins `base + i*stride` in a callee-saved
 * register per (array, index) pair, so repeated accesses within a region are
 * single `ldr [reg, #off]` loads (float fields straight into d0) instead of
 * re-deriving the whole address per access.
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const READ_SHAPE = `
import System

struct P {
	var float x
	var float y
	var float z
}

func sum_pairs = (ref P[3] ps, out float) {
	var i = 0
	var s = 0.0
	while i < 3; i += 1 {
		s = s + ps.at(i).x + ps.at(i).y
	}
	return s
}
pub func main = () {}
`;

test("repeated .at(i) reads pin one element address and reuse it", () => {
	const code = compile(READ_SHAPE);
	const fn = code.slice(code.indexOf("\nsum_pairs:"), code.indexOf("\n_main:"));
	// Exactly one fill: the pinned element address (pow2 struct size → the
	// shifted-register add form).
	const fills = fn.match(/add x\d+, x9, x1, lsl #\d+/g) ?? [];
	expect(fills).toHaveLength(1);
	const reg = fills[0]!.split(",")[0]!.replace("add ", "");
	// Both field loads ride the SAME pinned register — no second address
	// derivation, and the float hop loads d0 directly (no x0 crossing).
	expect(fn).toContain(`ldr d0, [${reg}, #8]`);
	expect(fn).toContain(`ldr d0, [${reg}, #16]`);
	// The pre-tranche idiom is gone from the loop body.
	expect(fn).not.toContain(`mul x1, x1, x2`);
});

test("kill switch restores the historical per-access address derivation", () => {
	set_array_licm_enabled(false);
	try {
		const code = compile(READ_SHAPE);
		const fn = code.slice(code.indexOf("\nsum_pairs:"), code.indexOf("\n_main:"));
		// No pinned address, no direct d0 field hop: both accesses derive
		// the address and load through x0.
		expect(fn).not.toMatch(/add x\d+, x9, x1, lsl #\d+/);
		expect(fn.match(/ldr x0, \[x0, #8\]/g) ?? []).toHaveLength(1);
		expect(fn.match(/ldr x0, \[x0, #16\]/g) ?? []).toHaveLength(1);
	} finally {
		set_array_licm_enabled(true);
	}
});

test("a post-loop access re-derives after the index update dropped the pin", () => {
	const code = compile(`
import System

struct P {
	var float x
	var float y
	var float z
}

func tail_read = (ref P[4] ps, out float) {
	var j = 0
	var s = 0.0
	while j < 3; j += 1 {
		s = s + ps.at(j).x * 10.0
	}
	s = s + ps.at(j).x
	return s
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("\ntail_read:"), code.indexOf("\n_main:"));
	// The loop's `j += 1` update invalidates the pinned address, so the
	// post-loop access must derive a fresh one: two fill sites in the text.
	const fills = fn.match(/add x\d+, x9, x1, lsl #\d+/g) ?? [];
	expect(fills).toHaveLength(2);
});

test("field stores through .at(i) write via the pinned register (no base push)", () => {
	const code = compile(`
import System

struct P {
	var float x
	var float y
	var float z
}

func scale = (ref P[3] ps, float k) {
	var i = 0
	while i < 3; i += 1 {
		ps.at(i).x = ps.at(i).x * k
	}
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("\nscale:"), code.indexOf("\n_main:"));
	const fills = fn.match(/add x\d+, x9, x1, lsl #\d+/g) ?? [];
	expect(fills).toHaveLength(1);
	const reg = fills[0]!.split(",")[0]!.replace("add ", "");
	// The RHS read and the store both go through the pinned register, and
	// the store path skips the historical base push/pop pair.
	expect(fn).toContain(`ldr d0, [${reg}, #8]`);
	expect(fn).toMatch(new RegExp(`str x\\d+, \\[${reg}, #8\\]`));
	expect(fn).not.toContain(`str x0, [sp, #-16]!`);
});

test("unrolled index-constant copies re-derive the pinned address per copy", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	const { set_loop_unrolling_enabled } = await import("../src/build_aarch64/unroll");
	// Composed unrolling (ASM_PLAN_3 tranche C): the outer loop unrolls in
	// index-constant mode (body reads `i`), the inner `j = i + 1` loop
	// unrolls inside each outer copy. Cache keys ride the induction's NAME
	// (`ps@j`) and the update that would invalidate them is deleted in
	// index-constant mode — so without the per-copy cache clearing, copy
	// k+1's accesses hit copy k's pin and read the wrong element.
	set_loop_unrolling_enabled(true);
	try {
		await build_and_check_output(
			`
import System

struct P {
	var float x
	var float y
	var float z
}

func advance_like = (ref P[4] ps, out float) {
	var i = 0
	while i < 2; i += 1 {
		const float bi = ps.at(i).x
		var int j = i + 1
		while j < 4; j += 1 {
			ps.at(j).x = ps.at(j).x + bi
			ps.at(j).y = ps.at(j).y + ps.at(j).x
		}
	}
	var s = 0.0
	var k = 0
	while k < 4; k += 1 {
		s = s + ps.at(k).x + ps.at(k).y
		k += 1
	}
	return s
}

pub func main = () {
	var P[4] ps = [P(1.0, 0.0, 0.0), P(2.0, 0.0, 0.0), P(4.0, 0.0, 0.0), P(8.0, 0.0, 0.0)]
	advance_like(ref ps)
	Console.write(ps.at(1).x.to_string())
	Console.write("\\n")
	Console.write(ps.at(2).x.to_string())
	Console.write("\\n")
	Console.write(ps.at(3).x.to_string())
	Console.write("\\n")
	Console.write(ps.at(3).y.to_string())
	Console.write("\\n")
}
`,
			"array_licm_unroll",
			"3.000000\n8.000000\n12.000000\n21.000000",
			true,
		);
	} finally {
		set_loop_unrolling_enabled(false);
	}
});

test("behavioral: struct-array pipeline prints exact results", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

struct P {
	var float x
	var float y
}

func advance_all = (ref P[4] ps, float k, out float) {
	var i = 0
	while i < 3; i += 1 {
		ps.at(i).x = ps.at(i).x + ps.at(i).y * k
		ps.at(i).y = ps.at(i).y - ps.at(i).x * 0.5
	}
	var s = 0.0
	var j = 0
	while j < 3; j += 1 {
		s = s + ps.at(j).x * 10.0 + ps.at(j).y
		j += 1
	}
	s = s + ps.at(j).x
	return s
}

pub func main = () {
	var P[4] ps = [P(1.0, 2.0), P(3.0, 4.0), P(5.0, 6.0), P(7.0, 8.0)]
	advance_all(ref ps, 2.0)
	Console.write(ps.at(0).x.to_string())
	Console.write("\\n")
	Console.write(ps.at(0).y.to_string())
	Console.write("\\n")
	Console.write(ps.at(2).x.to_string())
	Console.write("\\n")
	Console.write(ps.at(3).x.to_string())
	Console.write("\\n")
}
`,
		"array_licm_pipeline",
		"5.000000\n-0.500000\n17.000000\n7.000000",
		true,
	);
});

test("struct-array loop bodies are call-free: consts promote and trees fire", () => {
	// Fixed-array `.at(i)` inlines to a pure strided load (no `bl`), so the
	// loop body counts as call-free and the extension pools promote its
	// body-declared consts (ASM_PLAN_3 pre-D slice). Before the fix,
	// tree_is_call_free treated `.at` as a call: d_sq/dist/mag stayed in
	// slots and every add spilled through [sp].
	const code = compile(`
import System

struct B {
	var float x
	var float y
	var float z
	var float vx
	var float vy
	var float vz
	var float mass
}

func kern = (ref B[4] bs, float dt, out float) {
	var i = 0
	while i < 4; i += 1 {
		const float bi_x = bs.at(i).x
		var int j = 0
		while j < 4; j += 1 {
			const float dx = bi_x - bs.at(j).x
			const float d_sq = dx * dx + dx * 3.0
			const float dist = Math.sqrt(d_sq)
			const float mag = dt / (d_sq * dist)
			bs.at(j).vx = bs.at(j).vx + dx * mag
			j += 1
		}
	}
	return bs.at(0).vx
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("\nkern:"), code.indexOf("\n_main:"));
	// d_sq's initializer rides the float expression tree (v16+ temps, root
	// straight into its promoted register) — no [sp] spill pairs in the
	// inner loop, and the division root lands in mag's promoted register.
	expect(fn).toMatch(/fmul d1[6-9], d\d+, d\d+/);
	expect(fn).toMatch(/fdiv d\d+, d\d+, d\d+/);
	// The d_sq chain itself spills nothing; the field-WRITE marshalling
	// keeps its own (pre-existing) one-pair spill.
	expect((fn.match(/str d0, \[sp, #-16\]!/g) ?? []).length).toBeLessThanOrEqual(2);
});
