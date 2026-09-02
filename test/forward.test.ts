import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_forwarding_enabled } from "../src/build_aarch64/forward";
import { parse_raw } from "./parse_with_imports";

/**
 * Stage-4 straight-line store-to-load traffic elimination (ASM_PLAN_3):
 *
 * - SINGLE-USE FORWARDING: a scalar declared once, read once, never
 *   written, whose initializer is a pure int expression, is re-emitted at
 *   its single read site — the def's `str` and the use's `ldr` both
 *   disappear (the pool-exhausted temps the promoter leaves in slots, like
 *   div_to's d_hi/q_hi).
 * - WRITE-ONLY CSET-PAIR ELISION: the tranche-B fuse whose flag is never
 *   read anywhere loses its whole cmp/cset/store tail.
 *
 * The pass is cursor-dependent (its one-statement AST swap rides the
 * emission cursor), so the byte-identity harness holds it off in both
 * arms; these tests exercise it directly.
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

function compile_both(source: string): { off: string; on: string } {
	set_forwarding_enabled(false);
	const off = compile(source);
	set_forwarding_enabled(true);
	const on = compile(source);
	set_forwarding_enabled(true);
	return { off, on };
}

// The div_to estimate step's exact shape: four two-read products eat the
// caller-saved pool, so d_hi/q_hi (one read each) stay slot-resident —
// and the two carry flags are write-only (their reader is commented out).
const ESTIMATE = `
import System

func estimate = (uint64 q, uint64 d, out uint64) {
	const uint64 d_lo = d & 4294967295
	const uint64 d_hi = d >> 32
	const uint64 q_lo = q & 4294967295
	const uint64 q_hi = q >> 32
	const uint64 p_ll = q_lo * d_lo
	const uint64 p_lh = q_lo * d_hi
	const uint64 p_hl = q_hi * d_lo
	const uint64 p_mid = p_lh + p_hl
	var p_mc = 0
	if p_mid < p_lh {
		p_mc = 1
	}
	const uint64 p_lo = p_ll + (p_mid << 32)
	var p_lo_c = 0
	if p_lo < p_ll {
		p_lo_c = 1
	}
	return p_lo
}
pub func main = () {}
`;

test("single-use temps forward: def stores and use loads disappear", () => {
	const { off, on } = compile_both(`${ESTIMATE}`);
	const fn_off = off.slice(off.indexOf("\nestimate:"), off.indexOf("\n_main:"));
	const fn_on = on.slice(on.indexOf("\nestimate:"), on.indexOf("\n_main:"));
	// Pre-tranche: the single-use shifts round-trip their slots. Anchor the
	// two temps by their USE-site reloads (p_lh's and p_hl's muls).
	const d_hi_load = fn_off.match(/ldr x0, \[x29, #(\d+)\]\nmul x0, x13, x0/)?.[1];
	const q_hi_load = fn_off.match(/ldr x0, \[x29, #(\d+)\]\nmul x0, x0, x12/)?.[1];
	expect(d_hi_load).toBeDefined();
	expect(q_hi_load).toBeDefined();
	expect(fn_off).toMatch(new RegExp(`str x0, \\[x29, #${d_hi_load}\\]`));
	expect(fn_off).toMatch(new RegExp(`str x0, \\[x29, #${q_hi_load}\\]`));
	// Post-tranche: no slot traffic for either temp — the shifts re-emit
	// directly at the use sites.
	expect(fn_on).not.toContain(`[x29, #${d_hi_load}]`);
	expect(fn_on).not.toContain(`[x29, #${q_hi_load}]`);
	expect(fn_on).toContain("lsr x0, x1, x2");
});

test("write-only cset pairs lose their cmp/cset/store tail", () => {
	const { off, on } = compile_both(`${ESTIMATE}`);
	const fn_off = off.slice(off.indexOf("\nestimate:"), off.indexOf("\n_main:"));
	const fn_on = on.slice(on.indexOf("\nestimate:"), on.indexOf("\n_main:"));
	// Pre-tranche: both flags fuse into cmp/cset pairs (tranche B).
	expect(fn_off).toContain("cset x0, lo");
	// The flags are never read: post-tranche the whole tail is gone.
	expect(fn_on).not.toContain("cset");
	expect(fn_on).not.toMatch(/b\.lo end_\d+/);
});

test("kill switch restores the pre-tranche output byte-for-byte", () => {
	const { off, on } = compile_both(`${ESTIMATE}`);
	expect(on === off).toBe(false);
	// ...and the flag is a pure toggle: ON after OFF reproduces ON.
	const on_again = (() => {
		set_forwarding_enabled(true);
		return compile(`${ESTIMATE}`);
	})();
	expect(on_again).toEqual(on);
});

test("window with a branch boundary is not forwarded", () => {
	const gated = `
import System

func gated = (uint64 v, uint64 w, out uint64) {
	const uint64 hi = v >> 32
	var uint64 t = w
	if w > 100 {
		t = 7
	}
	return hi * t
}
pub func main = () {}
`;
	const { off, on } = compile_both(gated);
	// The if sits between def and use: no forwarding, byte-identical.
	expect(on).toEqual(off);
});

test("shadowed names are not forwarded", () => {
	const shadowed = `
import System

func shadow = (uint64 v, out uint64) {
	var uint64 hi = v >> 32
	if v > 100 {
		var uint64 hi = 5
	}
	return hi * v
}
pub func main = () {}
`;
	const { off, on } = compile_both(shadowed);
	expect(on).toEqual(off);
});

test("behavioral: forwarded products stay exact on both shapes", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// (2^32+3)(2^32+7) mod 2^64 = 10*2^32 + 21 = 42949672981 — the carry
	// paths (p_mc/p_lo_c = 1 shapes... both flags read 0 here) and the
	// forwarded d_hi/q_hi re-emissions all participate.
	await build_and_check_output(
		`
import System

func estimate = (uint64 q, uint64 d, out uint64) {
	const uint64 d_lo = d & 4294967295
	const uint64 d_hi = d >> 32
	const uint64 q_lo = q & 4294967295
	const uint64 q_hi = q >> 32
	const uint64 p_ll = q_lo * d_lo
	const uint64 p_lh = q_lo * d_hi
	const uint64 p_hl = q_hi * d_lo
	const uint64 p_mid = p_lh + p_hl
	var p_mc = 0
	if p_mid < p_lh {
		p_mc = 1
	}
	const uint64 p_lo = p_ll + (p_mid << 32)
	var p_lo_c = 0
	if p_lo < p_ll {
		p_lo_c = 1
	}
	return p_lo
}

pub func main = () {
	Console.write(estimate(4294967299, 4294967303).to_string())
	Console.write("\\n")
	Console.write(estimate(21474836480, 3).to_string())
	Console.write("\\n")
	Console.write(estimate(123456789, 987654321).to_string())
	Console.write("\\n")
}
`,
		"forward_pipeline",
		"42949672981\n64424509440\n121932631112635269",
		true,
	);
});

test("behavioral: forwarding survives loop re-execution", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// The div_to inner-loop shape: the forwards re-emit every iteration.
	await build_and_check_output(
		`
import System

func estimate = (uint64 q, uint64 d, out uint64) {
	const uint64 d_lo = d & 4294967295
	const uint64 d_hi = d >> 32
	const uint64 q_lo = q & 4294967295
	const uint64 q_hi = q >> 32
	const uint64 p_ll = q_lo * d_lo
	const uint64 p_lh = q_lo * d_hi
	const uint64 p_hl = q_hi * d_lo
	const uint64 p_mid = p_lh + p_hl
	const uint64 p_lo = p_ll + (p_mid << 32)
	return p_lo
}

pub func main = () {
	var uint64 acc = 0
	var i = 0
	while i < 5 {
		acc = acc + estimate(i * 4294967296 + 3, 7)
		i += 1
	}
	Console.write(acc.to_string())
	Console.write("\\n")
}
`,
		"forward_loop_pipeline",
		"300647710825",
		true,
	);
});
