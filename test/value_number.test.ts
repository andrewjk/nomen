import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_value_numbering_enabled } from "../src/build_aarch64/value_number";
import { parse_raw } from "./parse_with_imports";

/**
 * Loop value numbering (ASM_PLAN_3 tranche M): the invariant summands of a
 * pure `+` chain are hoisted into a `const _vn_N` declared BEFORE the loop —
 * a real statement in both the NIR spine and the AST list, so the register
 * allocator sees its traffic and may promote it — and each occurrence in the
 * loop reads the temp plus its variant (induction-dependent) leaves. This is
 * the cross-block / cross-iteration reuse the K and L surveys scoped: the
 * staging pins die at every label and back-edge, so the Knuth-D index
 * chains' invariant prefixes (`wd_off + u_len + 1`) were re-derived every
 * iteration; the hoisted temp is computed once and survives the boundary.
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", optimize: true });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

function preheader(code: string, fn: string): string {
	const in_fn = code.slice(code.indexOf(`\n${fn}:`), code.indexOf("\n_main:"));
	const start = in_fn.indexOf("\n.while_");
	expect(start).toBeGreaterThan(0);
	return in_fn.slice(0, start);
}

function first_loop_body(code: string, fn: string): string {
	const in_fn = code.slice(code.indexOf(`\n${fn}:`), code.indexOf("\n_main:"));
	const start = in_fn.indexOf("\n.while_");
	// The loop-END label (line-anchored): the back-branch targets it by
	// name, so a plain indexOf would cut the slice inside `b.ge .end_…`.
	const end = in_fn.indexOf("\n.end_while_", start);
	expect(start).toBeGreaterThan(0);
	return in_fn.slice(start, end);
}

const HOIST_LOOP = `
import System

func f = (int base, int off, out int) {
	var int total = 0
	var int i = 0
	while i < 4 {
		total = total + (base + off + i) + (base + off + i + 1)
		i += 1
	}
	return total
}

pub func main = () {
	Console.write("\\{f(1, 0)}")
}
`;

test("invariant index summands hoist to the preheader", () => {
	const code = compile(HOIST_LOOP);
	const pre = preheader(code, "f");
	// The hoisted temp inits (`base + off`, `base + off + 1`) are computed
	// BEFORE the loop label; the pre-tranche preheader holds only prologue
	// spills and promotion entry loads — no adds.
	expect(pre).toMatch(/add x\d+, x\d+, x\d+\n/);
	// The loop body no longer re-derives the invariant pairs: with VN on,
	// the body contains strictly fewer register-register adds than the off
	// build (the temps replaced the per-iteration re-derivation).
	set_value_numbering_enabled(false);
	try {
		const off_code = compile(HOIST_LOOP);
		const off_body = first_loop_body(off_code, "f");
		const on_body = first_loop_body(code, "f");
		const adds = (s: string) => (s.match(/add x\d+, x\d+, x\d+\n/g) ?? []).length;
		expect(adds(on_body)).toBeLessThan(adds(off_body));
	} finally {
		set_value_numbering_enabled(true);
	}
});

test("kill-switch restores the exact pre-tranche code", () => {
	const on = compile(HOIST_LOOP);
	set_value_numbering_enabled(false);
	try {
		const off = compile(HOIST_LOOP);
		const off_pre = preheader(off, "f");
		// The pre-tranche preheader holds no hoisted computation...
		expect(off_pre).not.toMatch(/add x\d+, x\d+, x\d+\n/);
		// ...and differs from the tranche's.
		expect(off_pre).not.toEqual(preheader(on, "f"));
		expect(off).not.toEqual(on);
	} finally {
		set_value_numbering_enabled(true);
	}
});

test("a loop-written name is not treated as invariant", () => {
	const source = `
import System

func f = (int off, out int) {
	var int base = 0
	var int total = 0
	var int i = 0
	while i < 4 {
		base = i
		total = total + (base + i) + (base + i + 1)
		i += 1
	}
	return total
}

pub func main = () {
	Console.write("\\{f(3)}")
}
`;
	const on = compile(source);
	set_value_numbering_enabled(false);
	try {
		const off = compile(source);
		// Every chain here reads a loop-written name (the only invariant
		// part is a lone literal) — the pass must leave the loop
		// byte-identical.
		expect(on).toEqual(off);
	} finally {
		set_value_numbering_enabled(true);
	}
});

test("occurrences inside if arms hoist (cross-block reuse)", () => {
	const code = compile(`
import System

func f = (int base, int off, out int) {
	var int total = 0
	var int i = 0
	while i < 4 {
		if total > 100 {
			total = total + (base + off + i)
		} else {
			total = total + (base + off + i + 1)
		}
		i += 1
	}
	return total
}

pub func main = () {
	Console.write("\\{f(1, 0)}")
}
`);
	// Both occurrences live in DIFFERENT arms; the hoist still extracts the
	// shared invariant pair to the preheader.
	expect(preheader(code, "f")).toMatch(/add x\d+, x\d+, x\d+\n/);
});

test("behavioral: hoisted loops produce exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// base=1, off=0: the loop sums (1+0+i) + (1+0+i+1) for i in 0..3 →
	// 1+2 + 2+3 + 3+4 + 4+5 = 24. The hoisted temps must hold the same
	// values across every iteration (cross-iteration reuse), including the
	// wrapping regrouping of the invariant prefix.
	await build_and_check_output(HOIST_LOOP, "value_number_basic", "24", true);
});
