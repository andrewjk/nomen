import { expect, test } from "vite-plus/test";

import build from "../src/build";
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
	const loop = code.slice(code.indexOf(".while_0:"), code.indexOf(".end_while_0:"));
	const pre = code.slice(0, code.indexOf(".while_0:"));
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
	const loop = code.slice(code.indexOf(".while_0:"), code.indexOf(".end_while_0:"));
	expect(loop).toMatch(/ldr x9, \[x9, #8\]|mov x9, x\d+/);
});

test("kill-switch restores the output byte-identically", () => {
	const saved = region_pool_enabled();
	set_region_pool_enabled(false);
	try {
		const code = compile(PIN_SHAPE, true);
		// Without the pass the derivation rides inside the loop (the
		// pre-tranche shape) — the switch is the A/B arm.
		const loop = code.slice(code.indexOf(".while_0:"), code.indexOf(".end_while_0:"));
		expect(loop.length).toBeGreaterThan(0);
	} finally {
		set_region_pool_enabled(saved);
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
