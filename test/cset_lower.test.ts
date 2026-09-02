import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_cset_lowering_enabled } from "../src/build_aarch64/cset_lower";
import { parse_raw } from "./parse_with_imports";

/**
 * Branch-free comparison-assign lowering (ASM_PLAN_3 tranche B):
 * `var x = 0; if <pure scalar cmp> { x = 1 }` fuses into declare +
 * `cmp/cset` + store — no branch, no join label. Removing the block
 * boundary is what stops live expression temps round-tripping their
 * frame slots around the flag write in hot straight-line kernels
 * (BigInt's Knuth-D carry chain).
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const CARRY_SHAPE = `
import System

func carries = (uint64 a, uint64 b, out uint64) {
	var p_mc = 0
	if a < b {
		p_mc = 1
	}
	return p_mc
}
pub func main = () {}
`;

test("declare + if fuses into cmp/cset with no branch", () => {
	const code = compile(CARRY_SHAPE);
	const fn = code.slice(code.indexOf("\ncarries:"), code.indexOf("\n_main:"));
	// The comparison materializes straight into x0 and stores to the flag's
	// home; the branch + join label are gone.
	expect(fn).toContain(`cmp x1, x2\n`);
	expect(fn).toContain(`cset x0, lo\n`);
	expect(fn).not.toMatch(/b\.lo end_\d+/);
	expect(fn).not.toMatch(/^end_\d+:/m);
});

test("kill switch restores the branchy shape", () => {
	set_cset_lowering_enabled(false);
	try {
		const code = compile(CARRY_SHAPE);
		const fn = code.slice(code.indexOf("\ncarries:"), code.indexOf("\n_main:"));
		expect(fn).not.toContain(`cset x0, lo`);
		// The branchy shape branches on the INVERSE condition (skip the
		// flag write when a >= b → b.hs).
		expect(fn).toMatch(/b\.hs end_\d+/);
	} finally {
		set_cset_lowering_enabled(true);
	}
});

test("signed operands take the signed condition code", () => {
	const code = compile(`
import System

func sc = (int a, int b, out int) {
	var f = 0
	if a < b {
		f = 1
	}
	return f
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("\nsc:"), code.indexOf("\n_main:"));
	expect(fn).toContain(`cset x0, lt\n`);
});

test("negated comparisons emit the inverted cset", () => {
	const code = compile(`
import System

func neg = (uint64 a, uint64 b, out uint64) {
	var f = 0
	if !(a < b) {
		f = 1
	}
	return f
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("\nneg:"), code.indexOf("\n_main:"));
	expect(fn).toContain(`cset x0, lo\n`);
	expect(fn).toContain(`eor x0, x0, #1\n`);
});

test("compound conditions keep their branches", () => {
	const code = compile(`
import System

func both = (uint64 a, uint64 b, out uint64) {
	var f = 0
	if a != 0 && b != 0 {
		f = 1
	}
	return f
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("\nboth:"), code.indexOf("\n_main:"));
	// Short-circuit branches have no dot form (b.eq/b.ne materialized-bool
	// tests, or direct b.cc from emit_cond_branch).
	expect(fn).toMatch(/b[a-z.]+ end_\d+/);
});

test("behavioral: fused flags print exact results", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func carries = (uint64 a, uint64 b, out uint64) {
	var p_mc = 0
	if a < b {
		p_mc = 1
	}
	var p_lo_c = 0
	if a == 7 {
		p_lo_c = 1
	}
	return p_mc * 10 + p_lo_c
}

pub func main = () {
	Console.write(carries(3, 9).to_string())
	Console.write("\\n")
	Console.write(carries(9, 3).to_string())
	Console.write("\\n")
	Console.write(carries(7, 7).to_string())
	Console.write("\\n")
}
`,
		"cset_lower_pipeline",
		"10\n0\n1",
		true,
	);
});
