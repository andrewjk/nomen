import { expect, test } from "vite-plus/test";

import build from "../src/build";
import {
	region_pool_enabled,
	set_region_pool_enabled,
} from "../src/build_aarch64/utils/nir_regalloc";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

/**
 * Loop-induction pins in region brackets (ASM_PLAN_7 tranche 2).
 *
 * A loop-carried scalar induction (written in the latch, read everywhere)
 * that emit-time loop promotion cannot reach (pool-exhausted: every pool
 * register holds a genuinely live occupant) is pinned into a scratch
 * register for the bracket: entry load before the header, name bound for
 * the body, final value stored back after the loop. The pidigits receipt:
 * div_to's D3 `pi` loop paid 6 slot ops/iteration (`ldr x1, [x29, #336]`
 * for the condition plus two index reads plus the full slot round-trip
 * update); after the pin the loop steps `add x7, x7, #1` with zero
 * in-loop slot traffic.
 */

const STARVED_SHAPE = `
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
	var int m = 21
	var int o = 22
	var q_hat = 7 as uint64
	var hv_carry = 0 as uint64
	var pi = 0
	while pi < buf.cap; pi += 1 {
		var uint64 vv = buf.load_int(pi) as uint64
		var uint64 lo_prod = q_hat * vv
		var uint64 p_lo = lo_prod + hv_carry
		hv_carry = p_lo >> 32
		if p_lo < lo_prod {
			hv_carry += 1
		}
		buf.store_int(pi, p_lo as int)
		hv_carry += (a + a + a + a + b + b + b + b + c + c + c + c + d + d + d + d) as uint64
		hv_carry += (e + e + e + e + f + f + f + f + g + g + g + g + h + h + h + h) as uint64
		hv_carry += (j + j + j + j + k + k + k + k + m + m + m + m + o + o + o + o) as uint64
	}
	Console.write("\\{hv_carry} \\{pi}\\n")
}
`;

function compile(source: string, region_on: boolean): string {
	const saved = region_pool_enabled();
	set_region_pool_enabled(region_on);
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

/** The user program's main body: the System library is joined into the
 *  same single-TU build — some of its functions land after main (string
 *  helpers with their own `.while_` loops) — so the user's hot loop must
 *  be found inside main's region, not in the whole code. */
function main_region(code: string): string {
	const start = code.search(/^_main:$/m);
	expect(start).toBeGreaterThan(-1);
	const end = code.indexOf("\n.globl", start);
	return end === -1 ? code.slice(start) : code.slice(start, end);
}

/** Slice the LAST while loop: its header, body, update block, and tail. */
function hot_loop(code: string): { pre: string; body: string; update: string; post: string } {
	const region = main_region(code);
	const starts: { index: number; n: string }[] = [];
	for (const m of region.matchAll(/\.while_(\d+):/g)) {
		starts.push({ index: m.index!, n: m[1] });
	}
	expect(starts.length).toBeGreaterThan(0);
	const { index: start, n } = starts[starts.length - 1];
	const end_label = `.end_while_${n}:`;
	const end = region.indexOf(end_label, start);
	expect(end).toBeGreaterThan(start);
	const update_label = `.while_update_${n}:`;
	const update_start = region.indexOf(update_label, start);
	// Loops without an update clause (`while c { ... }` with the step in
	// the body) emit no update label — the whole body is the step.
	const update = update_start > start ? region.slice(update_start, end) : region.slice(start, end);
	return {
		pre: region.slice(Math.max(0, start - 1200), start),
		body: region.slice(start, end),
		update,
		post: region.slice(end, end + 400),
	};
}

test("pool-exhausted induction pins into a scratch register", () => {
	const code = compile(STARVED_SHAPE, true);
	const loop = hot_loop(code);
	// The induction's pre-loop value is entry-loaded into x4–x8.
	expect(loop.pre).toMatch(/ldr x[4-8], \[x29, #\d+\]/);
	// The latch steps the scratch register with no frame-slot traffic:
	// the old update materialized `x29 + #off` and round-tripped the
	// slot (6 instructions); the pin steps the register in one.
	expect(loop.update).toMatch(/add x[4-8], x[4-8], #1/);
	expect(loop.update).not.toContain("x29");
	// The condition compares the scratch register directly.
	expect(loop.body).toMatch(/cmp x[4-8],/);
	// The final value is stored back after the loop (the induction is
	// read after it, so the store-back survives dead-store elimination).
	expect(loop.post).toMatch(/str x[4-8], \[x29, #\d+\]/);
});

test("kill-switch restores the slot-resident induction", () => {
	const on = compile(STARVED_SHAPE, true);
	const off = compile(STARVED_SHAPE, false);
	const loop_on = hot_loop(on);
	const loop_off = hot_loop(off);
	// With the region pool off, the induction round-trips its frame slot
	// every iteration (condition load + update address math + store).
	expect(loop_off.update).toContain("x29");
	expect(loop_off.body).toMatch(/ldr x\d+, \[x29, #\d+\]/);
	// And the pin transform actually fired when on (register step, no
	// slot traffic in the latch).
	expect(loop_on.update).not.toContain("x29");
	expect(on).not.toBe(off);
});

test("a real call in the loop refuses the pin", () => {
	const with_call = STARVED_SHAPE.replace(
		"buf.store_int(pi, p_lo as int)",
		'buf.store_int(pi, p_lo as int)\n\t\tConsole.write("")',
	);
	const code = compile(with_call, true);
	const loop = hot_loop(code);
	// A real call clobbers the scratch set (args ride x0–x7), so the
	// bracket cannot borrow one: the induction stays slot-resident.
	expect(loop.update).toContain("x29");
});

test("a string-concat loop refuses the pin (hang receipt)", () => {
	// String `+` lowers to `bl string_add` (plus a `bl _free` of the old
	// value) — calls no call-free model flags — so a scratch-pinned
	// induction would be clobbered mid-iteration (observed as a hang:
	// the step never advanced the compared value). The heap-freedom
	// proof refuses the pin; the induction stays slot-resident.
	const code = compile(
		`
import System
pub func main = () {
	var string s = ""
	var int j = 0
	while j < 5 {
		s = s + "ab"
		j = j + 1
	}
	Console.write(s)
}
`,
		true,
	);
	const loop = hot_loop(code);
	expect(loop.update).toContain("x29");
	expect(loop.pre).not.toMatch(/ldr x[4-8], \[x29, #\d+\]/);
});

test("behavioral: starved induction loop (both backends)", async () => {
	await build_and_check_output(STARVED_SHAPE, "induction_pin_starved", "792 8\n", true);
});

const NESTED_SHAPE = `
import System
pub func main = () {
	var buf = Buffer<uint64>()
	buf.alloc_int(8)
	var i = 0
	while i < 8; i += 1 {
		buf.store_int(i, i + 1)
	}
	var int a = 11
	var int b = 12
	var int c = 13
	var int d = 14
	var int e = 15
	var int f = 16
	var total = 0 as uint64
	var o = 0
	while o < 4; o += 1 {
		var pi = 0
		while pi < buf.cap; pi += 1 {
			var uint64 vv = buf.load_int(pi) as uint64
			total += vv + (o as uint64) + (a + b + c + d + e + f) as uint64
			buf.store_int(pi, (vv + 1) as int)
		}
	}
	Console.write("\\{total} \\{o}\\n")
}
`;

test("behavioral: nested starved inductions (both backends)", async () => {
	await build_and_check_output(NESTED_SHAPE, "induction_pin_nested", "2832 4\n", true);
});
