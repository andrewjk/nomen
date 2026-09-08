import { expect, test } from "vite-plus/test";

import build from "../src/build";
import {
	loop_slot_promotion_enabled,
	set_loop_slot_promotion_enabled,
} from "../src/build_aarch64/asm_loop_promote";
import {
	region_pool_enabled,
	set_region_pool_enabled,
} from "../src/build_aarch64/utils/nir_regalloc";
import { parse_raw } from "./parse_with_imports";

/**
 * Scratch-set modeling at the NIR allocator level (ASM_PLAN_6): a call-free
 * loop whose standard pools are exhausted (every pool register holds a
 * genuinely live occupant) still pins its loop-invariant Buffer receiver
 * data pointers — into the caller-saved scratch registers x4–x8, which the
 * loop's emission provably never touches (plan-side scan: no real calls,
 * raw-only inline accessors confined to x0–x3, no struct-return paths, no
 * break/return cleanup emission). The bracket borrows a scratch register
 * with NOTHING to spill, no claim bit, and no exit restore — the pin dies
 * with the bracket (the pre-seeded cache dies with the loop builder's
 * snapshot restore). Kill-switch shared with region_pool_enabled.
 */

function compile(source: string, force_region = false): string {
	const saved = region_pool_enabled();
	if (force_region) set_region_pool_enabled(true);
	try {
		const parsed = parse_raw(source);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		return result.code;
	} finally {
		set_region_pool_enabled(saved);
	}
}

/** Ten loop-spanning hot ints (fill x23–x28) plus four loop-contained
 *  temporaries per iteration (claim x12–x15) — the pool is exhausted, so
 *  the region pin can only come from the scratch set. */
const EXHAUSTED_SHAPE = `
import System

pub func main = () {
	var buf = Buffer<uint64>()
	buf.alloc_int(8)
	var i = 0
	while i < 8; i += 1 {
		buf.store_int(i, i * 3 + 1)
	}
	var int a = 11
	var int b = 12
	var int c = 13
	var int d = 14
	var int e = 15
	var int f = 16
	var int g = 17
	var int h = 18
	var int j = 19
	var int k = 20
	var int total = 0
	i = 0
	while i < 32; i += 1 {
		var int t1 = a + b
		var int t2 = c + d
		var int t3 = e + f
		var int t4 = g + h
		var int idx = 0
		if i >= 0 && i < buf.cap {
			idx = i % 8
		}
		total += buf.load_int(idx) + t1 + t2 + t3 + t4 + j + j + k + k + a + b + c + d + e + f + g + h
		a += 1
		b += 2
		i += 1
	}
	Console.write("\\{total} \\{a} \\{b}")
}
`;

test("pool-exhausted call-free loop pins its receiver into a scratch register", () => {
	const code = compile(EXHAUSTED_SHAPE, true);
	const loop_start = code.indexOf(".while_1:");
	const loop = code.slice(loop_start, code.indexOf(".end_while_1:"));
	const pre = code.slice(0, loop_start);
	// The derivation runs once, BEFORE the header, into x4–x8 (x8 first).
	expect(pre).toMatch(/add x9, x29, #\d+\nldr x9, \[x9, #8\]\nmov x[4-8], x9\n/);
	// The in-loop access reads the pinned scratch register directly.
	expect(loop).toMatch(/ldr x0, \[x[4-8], x\d+, lsl #3\]/);
	expect(loop).not.toContain("ldr x9, [x9, #8]");
	// Nothing to spill, nothing to restore: the bracket neither spills a
	// displaced occupant nor reloads the scratch register at exit.
	expect(loop).not.toMatch(/str x[4-8], \[x29, #\d+\]/);
	const after = code.slice(code.indexOf(".end_while_1:"));
	expect(after.slice(0, 200)).not.toMatch(/ldr x[4-8], \[x29, #\d+\]\nmov x[4-8],/);
});

test("an inline method whose raw body touches a scratch register refuses the pin", () => {
	const code = compile(
		`
import System

struct Holder {
	var uint64 v
	inline func mix = (self, uint64 x, out uint64) {
		\`\`\`
		#arch: aarch64
		eor x0, x5, x1
		\`\`\`
	}
}

pub func main = () {
	var buf = Buffer<uint64>()
	buf.alloc_int(8)
	var holder = Holder(7)
	var i = 0
	while i < 8; i += 1 {
		buf.store_int(i, i * 3 + 1)
		i += 1
	}
	var int a = 11
	var int b = 12
	var int c = 13
	var int d = 14
	var int e = 15
	var int f = 16
	var int g = 17
	var int h = 18
	var int j = 19
	var int k = 20
	var int total = 0
	i = 0
	while i < 32; i += 1 {
		var int t1 = a + b
		var int t2 = c + d
		var int t3 = e + f
		var int t4 = g + h
		var int idx = 0
		if i >= 0 && i < buf.cap {
			idx = i % 8
		}
		total += buf.load_int(idx) + t1 + t2 + t3 + t4 + holder.mix(3) as int + j + j + k + k + a + b + c + d + e + f + g + h
		a += 1
		b += 2
		i += 1
	}
	Console.write("\\{total} \\{a} \\{b}")
}
`,
		true,
	);
	const loop = code.slice(code.indexOf(".while_1:"), code.indexOf(".end_while_1:"));
	expect(loop.length).toBeGreaterThan(0);
	// The scan refuses (x5 in the raw text): no scratch pin — the
	// derivation stays inline, re-run per iteration. Soundness first.
	expect(loop).toMatch(/ldr x9, \[x9, #8\]/);
	expect(loop).not.toMatch(/mov x[4-8], x9/);
	expect(loop).not.toMatch(/ldr x0, \[x[4-8], x\d+, lsl #3\]/);
});

test("kill-switch restores the pre-tranche shape", () => {
	const on = compile(EXHAUSTED_SHAPE, true);
	const saved = region_pool_enabled();
	const saved_loop_promote = loop_slot_promotion_enabled();
	set_region_pool_enabled(false);
	set_loop_slot_promotion_enabled(false);
	try {
		const off = compile(EXHAUSTED_SHAPE);
		// With the region gate off, the derivation rides inside the loop
		// and no scratch register is ever borrowed.
		const loop = off.slice(off.indexOf(".while_1:"), off.indexOf(".end_while_1:"));
		expect(loop.length).toBeGreaterThan(0);
		expect(loop).not.toMatch(/mov x[4-8], x9/);
		expect(off).not.toEqual(on);
	} finally {
		set_region_pool_enabled(saved);
		set_loop_slot_promotion_enabled(saved_loop_promote);
	}
});

test("behavioral: scratch-pinned loop prints exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(EXHAUSTED_SHAPE, "scratch_pool_exhausted", "5732 27 44", true);
});

test("behavioral: a loop whose break path hosts a live inner loop keeps its induction exact", async () => {
	// Region brackets around a loop with a BREAK path: the inner loop sits
	// outside the natural body yet executes inside the bracket, so the
	// region set must include it for the pin/borrow decisions. The
	// exhaust-shape regression this closure feeds rides test/lru.test.ts
	// (the find/sh-loop receipt); this holds the break-path shape exact on
	// both backends.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

pub func main = () {
	var order = Buffer<int>()
	order.alloc_int(8)
	var order_len = 0
	var i = 0
	while i < 8; i += 1 {
		order.store_int(i, i * 2)
	}
	order_len = 8
	var found = -1
	var n0 = 10
	var f = 0
	while f < order_len {
		if f >= 0 && f < order.cap && order.load_int(f) == n0 {
			var sh = f
			while sh < order_len - 1 {
				if sh >= 0 && sh < order.cap && sh + 1 < order.cap {
					order.store_int(sh, order.load_int(sh + 1))
				}
				sh = sh + 1
			}
			order_len = order_len - 1
			found = sh
			break
		}
		f = f + 1
	}
	Console.write("\\{found} \\{order_len} \\{order.load_int(2)}")
}
`,
		"scratch_pool_break_path",
		"7 7 4",
		true,
	);
});

/** Base-folded addressing (ASM_PLAN_6 tranche 3): the pinned receiver's
 *  pointer folds an invariant index base at bracket entry, and matching
 *  `base + var` accessor arguments index the fold register with the bare
 *  induction — the per-access base read + add disappear. The literal form
 *  (`4 + i2`) rides the plan's `_param` allocation resolution: VN
 *  deliberately skips literal-only invariant prefixes, so the un-spliced
 *  chain is recovered from the checker-hoisted allocation. */
const FOLD_SHAPE = `
import System

pub func main = () {
	var buf = Buffer<uint64>()
	buf.alloc_int(16)
	var i = 0
	while i < 16; i += 1 {
		buf.store_int(i, i * 3 + 1)
	}
	var int total = 0
	var i2 = 0
	while i2 < 8; i2 += 1 {
		if i2 >= 0 && i2 + 4 < buf.cap {
			total += buf.load_int(4 + i2)
		}
	}
	Console.write("\\{total}")
}
`;

test("base-fold: the pin folds an invariant base and accesses index the bare induction", () => {
	const code = compile(FOLD_SHAPE, true);
	const loop_start = code.indexOf(".while_1:");
	const loop = code.slice(loop_start, code.indexOf(".end_while_1:"));
	const pre = code.slice(0, loop_start);
	// The fold register is preloaded once, before the header (base 4 × 8).
	expect(pre).toMatch(/add x8, x\d+, #32\n/);
	// The access indexes the fold register with the bare induction —
	// no staged index chain, no base slot read inside the loop.
	expect(loop).toMatch(/ldr x0, \[x8, x\d+, lsl #3\]/);
	expect(loop).not.toMatch(/mov x10, #4/);
	expect(loop).not.toMatch(/add x10, x10, x\d+/);
});

test("behavioral: base-folded accesses print exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(FOLD_SHAPE, "scratch_pool_base_fold", "188", true);
});
