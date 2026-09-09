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
 * Region-scoped pool claims + loop-pinned receiver materialization
 * (ASM_PLAN_5 tranche 1): the allocator identifies callee-pool registers
 * whose function-wide occupants are dead throughout a loop's blocks; the
 * while-dispatch bracket borrows one (spilling/reloading the displaced
 * occupants through their frame slots), derives the loop's invariant
 * Buffer receiver data pointers into it BEFORE the loop header, and
 * pre-seeds `buffer_data_cache` — so in-loop accessor derivations emit
 * nothing and the receiver path is materialized once per LOOP instead of
 * once per iteration.
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

// Core library functions with Nomen bodies (BigInt, String.hash, …) emit
// their own `.while_N` loops before main's body, and loop labels are
// numbered globally — so main's loop labels must be discovered AFTER the
// `_main:` label rather than assumed to start at a fixed number. Returns
// main's loop numbers in order of first appearance (outermost first).
function main_loops(code: string): number[] {
	// main's body ends where the next function label begins (deferred
	// emissions of referenced core functions can follow main's ret).
	const start = code.indexOf("_main:");
	const body_start = code.indexOf("\n", start) + 1;
	let end = code.length;
	const next_fn = code.slice(body_start).match(/^[A-Za-z_][A-Za-z0-9_]*:/m);
	if (next_fn && next_fn.index !== undefined) end = body_start + next_fn.index;
	const nums: number[] = [];
	for (const m of code.slice(start, end).matchAll(/^\.while_(\d+):/gm)) {
		const n = Number(m[1]);
		if (!nums.includes(n)) nums.push(n);
	}
	return nums;
}

const PIN_SHAPE = `
import System

pub func main = () {
	var buf = Buffer<uint64>()
	buf.alloc_int(8)
	var i = 0
	while i < 6; i += 1 {
		buf.store_int(i, buf.load_int(i) + 1)
		i += 1
	}
	Console.write("\\{buf.load_int(0)} \\{buf.load_int(5)}")
}
`;

test("loop receiver derivation is hoisted above the loop header", () => {
	const code = compile(PIN_SHAPE, true);
	const [w] = main_loops(code);
	const loop = code.slice(code.indexOf(`.while_${w}:`), code.indexOf(`.end_while_${w}:`));
	const pre = code.slice(0, code.indexOf(`.while_${w}:`));
	// The receiver derivation runs once, BEFORE the header (the hoisted
	// form: receiver struct address + data-pointer load + pin copy).
	expect(pre).toMatch(/add x9, x\d+, #\d+\nldr x9, \[x9, #8\]\nmov x2[0-8], x9\n$/m);
	// The in-loop accesses read the pinned register — no per-iteration
	// derivation, no x9 staging copies.
	expect(loop).not.toContain("add x9,");
	expect(loop).not.toContain("ldr x9, [x9, #8]");
	expect(loop).toMatch(/x2[0-8], x\d+, lsl #3/);
	// A loop with NO pool occupants borrows a register with nothing to
	// spill (main's locals are slot-resident) — displaced-occupant
	// spill/reload coverage rides the BigInt benches' corpus runs.
});

test("a receiver written inside the loop is not pinned", () => {
	// `buf` is reassigned inside the loop — the derivation cannot hoist.
	const code = compile(`
import System

pub func main = () {
	var buf = Buffer<uint64>()
	buf.alloc_int(8)
	buf.store_int(0, 3)
	var i = 0
	while i < 4; i += 1 {
		buf.store_int(i, buf.load_int(i) + 1)
		if i == 2 {
			buf = Buffer<uint64>()
			buf.alloc_int(8)
		}
		i += 1
	}
	Console.write("\\{buf.load_int(0)}")
}
`);
	// The derivation appears INSIDE the loop (no hoist) — soundness first.
	const [w] = main_loops(code);
	const loop = code.slice(code.indexOf(`.while_${w}:`), code.indexOf(`.end_while_${w}:`));
	expect(loop).toMatch(/ldr x9, \[x9, #8\]|mov x9, x\d+/);
});

test("kill-switch restores the pre-tranche shape", () => {
	const on = compile(PIN_SHAPE, true);
	const saved = region_pool_enabled();
	const saved_loop_promote = loop_slot_promotion_enabled();
	set_region_pool_enabled(false);
	// The asm-level derivation hoist (ASM_PLAN_6) is independent of the
	// region-pool switch — hold it off too so this arm shows the raw
	// per-iteration derivation the region pin eliminates.
	set_loop_slot_promotion_enabled(false);
	try {
		const parsed = parse_raw(PIN_SHAPE);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		const off = result.code;
		// Without the pass the derivation rides inside the loop (the
		// pre-tranche shape) — the switch is the A/B arm.
		const [w] = main_loops(off);
		const loop = off.slice(off.indexOf(`.while_${w}:`), off.indexOf(`.end_while_${w}:`));
		expect(loop.length).toBeGreaterThan(0);
		expect(loop).toMatch(/ldr x9, \[x9, #8\]|add x9,/);
		// The two arms differ (the hoist fires by default ON).
		expect(off).not.toEqual(on);
	} finally {
		set_region_pool_enabled(saved);
		set_loop_slot_promotion_enabled(saved_loop_promote);
	}
});

test("behavioral: pinned receiver loops print exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

pub func main = () {
	var buf = Buffer<uint64>()
	buf.alloc_int(8)
	var i = 0
	while i < 8; i += 1 {
		buf.store_int(i, i)
	}
	i = 0
	while i < 8; i += 1 {
		buf.store_int(i, buf.load_int(i) * 2)
	}
	var acc = 0
	i = 0
	while i < 8; i += 1 {
		acc += buf.load_int(i)
	}
	Console.write(acc.to_string())
}
`,
		"region_pool_receivers",
		"56",
		true,
	);
});

test("behavioral: nested pinned loops keep pin and induction registers apart on both backends", async () => {
	// The knucleotide count_seq receipt: an outer region pin shared its
	// register with an inner loop's induction (promotion's sharing path
	// could not see the pin) and the loop loaded `[x26, x26, lsl #3]` —
	// segfault. The lru receipt: an outer pin borrowed a register whose
	// occupant was live in a nested loop the block set missed. Both now
	// refuse; the nest still pins (3 brackets fire here) and prints exact.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func f = (ref Buffer<int> buf, out int) {
	var int total = 0
	var i = 0
	while i < 8; i += 1 {
		if i >= 0 && i < buf.cap {
			total += buf.load_int(i)
		}
		var j = 0
		while j < i; j += 1 {
			if j >= 0 && j < buf.cap {
				total += buf.load_int(j)
			}
		}
	}
	return total
}

pub func main = () {
	var Buffer<int> buf = Buffer<int>()
	buf.grow_int(8)
	var i = 0
	while i < 8; i += 1 {
		buf.store_int(i, i + 1)
	}
	Console.write("\\{f(ref buf)}")
}
`,
		"region_pool_nested",
		"120",
		true,
	);
});

const REGION_VAR_SHAPE = `
import System

pub func main = () {
	var buf = Buffer<int>()
	buf.grow_int(8)
	var i = 0
	while i < 4; i += 1 {
		buf.store_int(i, i)
	}
	var int sum = 0
	var k = 0
	while k < 4; k += 1 {
		var int t = 0
		var j = 0
		while j < 4; j += 1 {
			t += j
			buf.store_int(j, t)
		}
		sum += t
	}
	Console.write(sum.to_string())
}
`;

test("region-scoped source variable binds a loop-contained local to a borrowed register", () => {
	// `t` accumulates across the INNER loop and is read after it — live
	// into the inner header (blocking the function-wide allocator's
	// low-read extension) and loop-contained in the OUTER loop, so the
	// plan assigns it to one of the outer loop's region-free registers.
	// The bracket binds it: the inner-loop accumulator's declare writes
	// the register (`mov xR, x0` after the zero init) instead of its slot.
	const code = compile(REGION_VAR_SHAPE, true);
	// The region-var bracket rides the SECOND loop (the nest): the first
	// loop is the buffer fill.
	const [, inner] = main_loops(code);
	const body = code.slice(code.indexOf(`.while_${inner}:`), code.indexOf(`.end_while_${inner}:`));
	// The accumulator's declare is register-bound: `mov x0, #0` followed
	// by a register copy (the slot form would be `str x0, [x29, #N]`).
	expect(body).toMatch(/mov x0, #0\nmov x(?:1[2-5]|2[0-8]), x0\n/);
	// The var needs no promotion entry load (it is defined inside the
	// loop): every pre-loop promotion load targets a slot the function
	// already stored (k/sum inits precede their loads). The pre-tranche
	// shape ALSO loads the accumulator from a slot whose first reference
	// is the load itself — a garbage read.
	const main_code = code.slice(code.indexOf("_main:"), code.indexOf(".return_0:"));
	const garbage_load = (text: string): boolean =>
		[...text.matchAll(/ldr x(?:1[2-5]|2[0-8]), \[x29, #(\d+)\]\n/g)].some((m) => {
			const before = text.slice(0, m.index ?? 0);
			return !new RegExp(`str x\\d+, \\[x29, #${m[1]}\\]`).test(before);
		});
	expect(garbage_load(main_code)).toBe(false);
});

test("kill-switch keeps region vars off (slot-resident shape restored)", () => {
	const saved = region_pool_enabled();
	set_region_pool_enabled(false);
	try {
		const parsed = parse_raw(REGION_VAR_SHAPE);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		// Without the pass the same locals ride loop promotion's bracket:
		// entry loads read their (garbage-then-discarded) slots before the
		// header — loads the region-var binding eliminates.
		// Promotion loads the accumulator's pre-allocated slot BEFORE the
		// declare ever runs — the slot's first textual reference is the
		// load itself (a garbage read). The region-var binding is exactly
		// what eliminates it.
		const main_code = result.code.slice(
			result.code.indexOf("_main:"),
			result.code.indexOf(".return_0:"),
		);
		const garbage_load = (text: string): boolean =>
			[...text.matchAll(/ldr x(?:1[2-5]|2[0-8]), \[x29, #(\d+)\]\n/g)].some((m) => {
				const before = text.slice(0, m.index ?? 0);
				return !new RegExp(`str x\\d+, \\[x29, #${m[1]}\\]`).test(before);
			});
		expect(garbage_load(main_code)).toBe(true);
	} finally {
		set_region_pool_enabled(saved);
	}
});

test("behavioral: region-scoped source variables print exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// t = 0+1+2+3 = 6 per outer iteration; sum = 4 * 6 = 24.
	await build_and_check_output(REGION_VAR_SHAPE, "region_pool_vars", "24", true);
});
