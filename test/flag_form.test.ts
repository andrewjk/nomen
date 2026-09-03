import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_flag_form_enabled } from "../src/build_aarch64/flag_form";
import { parse_raw } from "./parse_with_imports";

/**
 * Flag-form carry lowering (ASM_PLAN_3 tranche J): a scalar declare whose
 * init is a plain `+`/`-` of names, followed by (at most one plain assign
 * and) a materialized carry compare — `var uint64 c = 0; if prod < a { c = 1 }`
 * or `if prod < a { x += 1 }` — lowers the root op as adds/subs and
 * materializes the flag from the carry/borrow flags: one cset, or one
 * cinc on a register home (clang's `adds; cinc` idiom). No cmp, no
 * operand staging, no branch in the fused window.
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

function function_body(code: string, name: string): string {
	return code.slice(code.indexOf(`\n${name}:`), code.indexOf("\n_main:"));
}

const ADD_CARRY = `
import System

func f1 = (uint64 a, uint64 b, out uint64) {
	const uint64 d = a + b
	var uint64 c = 0
	if d < a {
		c = 1
	}
	return c + d
}
pub func main = () {}
`;

test("add-carry compare folds into adds + cset hs with no cmp", () => {
	const code = compile(ADD_CARRY);
	const fn = function_body(code, "f1");
	expect(fn).toMatch(/adds x\d+, x\d+, x\d+\n/);
	expect(fn).toMatch(/cset x\d+, hs\n/);
	// The compare's cmp + operand staging are gone: no cmp directly
	// feeding a cset anywhere in the body.
	expect(fn).not.toMatch(/cmp x\d+, x\d+\ncset /);
	expect(fn).not.toMatch(/b\.hs end_\d+/);
});

test("sub-borrow compare folds into subs + cset lo", () => {
	const code = compile(`
import System

func f2 = (uint64 u, uint64 p, out uint64) {
	const uint64 diff = u - p
	var uint64 b1 = 0
	if diff > u {
		b1 = 1
	}
	return b1 + diff
}
pub func main = () {}
`);
	const fn = function_body(code, "f2");
	expect(fn).toMatch(/subs x\d+, x\d+, x\d+\n/);
	expect(fn).toMatch(/cset x\d+, lo\n/);
	expect(fn).not.toMatch(/cmp x\d+, x\d+\ncset /);
});

test("compound assign on a register home folds into adds + cinc", () => {
	const code = compile(`
import System

func f3 = (uint64 a, uint64 b, out uint64) {
	var uint64 hv = 5
	const uint64 q = b + hv
	hv = a
	if q < b {
		hv += 1
	}
	return hv + q
}
pub func main = () {}
`);
	const fn = function_body(code, "f3");
	expect(fn).toMatch(/adds x\d+, x\d+, x\d+\n/);
	expect(fn).toMatch(/cinc x\d+, x\d+, hs\n/);
	// The branchy `b.hs end_N; add xN, xN, #1` pair is gone.
	expect(fn).not.toMatch(/b\.hs end_\d+/);
	expect(fn).not.toMatch(/cmp x\d+, x\d+\ncset /);
});

test("negated carry compare inverts the flag condition code", () => {
	const code = compile(`
import System

func f4 = (uint64 a, uint64 b, out uint64) {
	const uint64 d = a + b
	var uint64 c = 0
	if !(d < a) {
		c = 1
	}
	return c + d
}
pub func main = () {}
`);
	const fn = function_body(code, "f4");
	expect(fn).toMatch(/adds x\d+, x\d+, x\d+\n/);
	expect(fn).toMatch(/cset x\d+, lo\n/);
});

test("kill switch restores the cmp/cset shape byte-for-byte", () => {
	set_flag_form_enabled(false);
	try {
		const code = compile(ADD_CARRY);
		const fn = function_body(code, "f1");
		expect(fn).not.toMatch(/adds x\d+/);
		expect(fn).not.toMatch(/cinc x\d+/);
		// The tranche-B fuse still fires: a branch-free cmp/cset pair.
		expect(fn).toMatch(/cmp x\d+, x\d+\ncset x\d+, lo\n/);
	} finally {
		set_flag_form_enabled(true);
	}
});

test("signed operands decline the flag form (cmp/cset lt stays)", () => {
	const code = compile(`
import System

func f5 = (int a, int b, out int) {
	const int d = a + b
	var int c = 0
	if d < a {
		c = 1
	}
	return c + d
}
pub func main = () {}
`);
	const fn = function_body(code, "f5");
	expect(fn).not.toMatch(/adds x\d+/);
	expect(fn).toMatch(/cset x\d+, lt\n/);
});

test("comparisons with no flag equivalent decline", () => {
	const code = compile(`
import System

func f6 = (uint64 a, uint64 b, out uint64) {
	const uint64 d = a + b
	var uint64 c = 0
	if d == a {
		c = 1
	}
	const uint64 diff = a - b
	var uint64 e = 0
	if diff < a {
		e = 1
	}
	return c + e + d + diff
}
pub func main = () {}
`);
	const fn = function_body(code, "f6");
	// `==` after `+` and `<` after `-` are not the carry/borrow flag.
	expect(fn).not.toMatch(/adds x\d+/);
	expect(fn).not.toMatch(/subs x\d+/);
	expect(fn).not.toMatch(/cinc x\d+/);
});

test("an arithmetic intervening assign blocks the fold", () => {
	const code = compile(`
import System

func f7 = (uint64 a, uint64 b, out uint64) {
	var uint64 hv = 5
	const uint64 q = b + hv
	hv = a + 1
	if q < b {
		hv += 1
	}
	return hv + q
}
pub func main = () {}
`);
	const fn = function_body(code, "f7");
	expect(fn).not.toMatch(/adds x\d+/);
	expect(fn).not.toMatch(/cinc x\d+/);
});

test("behavioral: folded carries print exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

const uint64 MAX = 18446744073709551615

func add_carry = (uint64 a, uint64 b, out uint64) {
	const uint64 d = a + b
	var uint64 c = 0
	if d < a {
		c = 1
	}
	return c
}

func sub_borrow = (uint64 u, uint64 p, out uint64) {
	const uint64 diff = u - p
	var uint64 c = 0
	if diff > u {
		c = 1
	}
	return c
}

func carry_inc = (uint64 a, uint64 b, out uint64) {
	var uint64 hv = 5
	const uint64 q = b + hv
	hv = a
	if q < b {
		hv += 1
	}
	return hv
}

pub func main = () {
	Console.write(add_carry(MAX, 1).to_string())
	Console.write("\\n")
	Console.write(add_carry(3, 9).to_string())
	Console.write("\\n")
	Console.write(sub_borrow(3, 9).to_string())
	Console.write("\\n")
	Console.write(sub_borrow(9, 3).to_string())
	Console.write("\\n")
	Console.write(carry_inc(41, MAX).to_string())
	Console.write("\\n")
	Console.write(carry_inc(41, 3).to_string())
	Console.write("\\n")
}
`,
		"flag_form_pipeline",
		"1\n0\n1\n0\n42\n41",
		true,
	);
});
