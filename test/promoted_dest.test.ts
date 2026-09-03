import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_float_forwarding_enabled } from "../src/build_aarch64/asm_opt";
import { set_cset_lowering_enabled } from "../src/build_aarch64/cset_lower";
import { parse_raw } from "./parse_with_imports";

/**
 * Stage-5 promoted-destination statement lowering (ASM_PLAN_3):
 *
 * - CSET DEST HINT: a fused carry flag with a promoted register home takes
 *   the `cset xN, cc` directly — no x0 staging, no `mov xN, x0`, and the
 *   literal-0 initializer (dead under tranche B's contract: the fused cset
 *   overwrites it before any read) is skipped entirely.
 * - COMPOUND-ASSIGN fast path: `i += 1` on a promoted target folds to
 *   `add xI, xI, #imm`. (The plan-2-F fast path checked `operator === "+"`
 *   but compound assigns carry the two-char token `"+="` — it never fired.)
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const CARRY_LOOP = `
import System

func carries = (uint64 a, uint64 b, out uint64) {
	var uint64 carry = 0
	var i = 0
	while i < 4; i += 1 {
		const uint64 sum = a + b
		var c1 = 0
		if sum < a {
			c1 = 1
		}
		carry = carry + c1
	}
	return carry
}
pub func main = () {}
`;

test("fused flag with a register home takes cset directly, no dead init", () => {
	const code = compile(CARRY_LOOP);
	const fn = code.slice(code.indexOf("\ncarries:"), code.indexOf("\n_main:"));
	// The cset lands in a promoted register (not x0), with no staging mov.
	expect(fn).toMatch(/cset x(?:1[2-5]|2[0-8]), lo\n/);
	expect(fn).not.toMatch(/cset x0, lo\nmov x(?:1[2-5]|2[0-8]), x0/);
	// The flag's home register receives nothing but the cset: the old shape
	// staged `mov x0, #0; mov xHOME, x0` (the dead 0-init) before it.
	const cset_home = fn.match(/cset (x(?:1[2-5]|2[0-8])), lo/)?.[1];
	expect(cset_home).toBeDefined();
	expect(fn).not.toContain(`mov ${cset_home}, x0`);
});

test("slot-home flags keep the declare + x0 cset shape", () => {
	// Many simultaneously-live locals exhaust the pool so the flag lands in
	// a slot; the fuse then keeps the declare + `cset x0` + store shape.
	const code = compile(`
import System

func slotflag = (uint64 a, uint64 b, out uint64) {
	var uint64 s1 = a * 3
	var uint64 s2 = s1 + b
	var uint64 s3 = s2 ^ a
	var uint64 s4 = s3 - b
	var uint64 s5 = s4 | s1
	var f = 0
	if a < b {
		f = 1
	}
	return s1 + s2 + s3 + s4 + s5 + f
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("\nslotflag:"), code.indexOf("\n_main:"));
	expect(fn).toContain("cset x0, lo\n");
});

test("cset kill switch still restores the branchy shape", () => {
	set_cset_lowering_enabled(false);
	try {
		const code = compile(CARRY_LOOP);
		const fn = code.slice(code.indexOf("\ncarries:"), code.indexOf("\n_main:"));
		expect(fn).not.toContain("cset");
		expect(fn).toMatch(/b\.[a-z]+ end_\d+/);
	} finally {
		set_cset_lowering_enabled(true);
	}
});

test("compound assign on a promoted target folds to add/sub imm", () => {
	const code = compile(`
import System

func bumps = (uint64 v, out uint64) {
	var uint64 acc = v
	acc += 1
	acc += 4095
	acc -= 2
	acc += 4096
	return acc
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("\nbumps:"), code.indexOf("\n_main:"));
	// imm12-range literals fold into the register home; 4096 does not.
	expect(fn).toMatch(/add x(?:1[2-5]|2[0-8]), x(?:1[2-5]|2[0-8]), #1\n/);
	expect(fn).toMatch(/add x(?:1[2-5]|2[0-8]), x(?:1[2-5]|2[0-8]), #4095\n/);
	expect(fn).toMatch(/sub x(?:1[2-5]|2[0-8]), x(?:1[2-5]|2[0-8]), #2\n/);
	expect(fn).not.toContain("add x(?:1[2-5]|2[0-8]), x(?:1[2-5]|2[0-8]), #4096");
	// 4096 keeps the generic compound sequence (a load or mov of the
	// literal, then add, then store back to the home).
	expect(fn).toMatch(/#4096/);
});

test("behavioral: promoted flags and compound bumps stay exact", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func carries = (uint64 a, uint64 b, out uint64) {
	var uint64 carry = 0
	var i = 0
	while i < 4; i += 1 {
		const uint64 sum = a + b
		var c1 = 0
		if sum < a {
			c1 = 1
		}
		carry = carry + c1
	}
	return carry
}

func bumps = (uint64 v, out uint64) {
	var uint64 acc = v
	acc += 1
	acc -= 2
	acc += 10
	return acc
}

pub func main = () {
	Console.write(carries(3, 9).to_string())
	Console.write("\\n")
	Console.write(carries(18446744073709551615, 1).to_string())
	Console.write("\\n")
	Console.write(bumps(5).to_string())
	Console.write("\\n")
}
`,
		"promoted_dest_pipeline",
		"0\n4\n14",
		true,
	);
});

test("behavioral: inlined float param keeps its type through loop promotion", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// A float param of an inlined callee, called from a call-free loop:
	// the expansion's loop promotion resolves the param type through
	// function_param_types — a typeless float param fell into the
	// ""→int default and claimed an x-register (the mbrot ci/cr receipt,
	// via the expansion door).
	await build_and_check_output(
		`
import System

func scale = (float v, float k, out float) {
	return v * k
}

pub func main = () {
	var float acc = 1.0
	var i = 0
	while i < 4 {
		acc = scale(acc, 1.5)
		i += 1
	}
	Console.write("\\{acc}")
}
`,
		"expansion_float_param_pipeline",
		"5.0625",
		true,
	);
});

test("float-bits forwarding collapses the sqrt d0 crossing", () => {
	set_float_forwarding_enabled(true);
	const code = compile(`
import System

func dist = (float a, float b, out float) {
	var float d = a - b
	var float r = Math.sqrt(d * d)
	return r * 2.0
}
pub func main = () {}
`);
	const fn = code.slice(code.indexOf("\ndist:"), code.indexOf("\n_main:"));
	// The 5-instruction crossing (fmov x0, dA; fmov d0, x0; fsqrt; fmov
	// x0, d0; fmov dB, x0) collapses: the sqrt's arg and result move
	// d↔d directly — no staging through x0, no self-moves.
	expect(fn).toMatch(/fsqrt d[0-9]+, d[0-9]+\n/);
	// No d↔d self-moves (the rewritten-from x0 staging degenerate).
	expect(fn).not.toMatch(/fmov d([0-9]+), d\1\n/);
	expect(fn).not.toContain("fmov d0, x0\nfmov x0, d0");
});

test("float forwarding kill switch restores the crossings", () => {
	set_float_forwarding_enabled(false);
	try {
		const code = compile(`
import System

func dist = (float a, float b, out float) {
	var float d = a - b
	return Math.sqrt(d * d)
}
pub func main = () {}
`);
		const fn = code.slice(code.indexOf("\ndist:"), code.indexOf("\n_main:"));
		expect(fn).toContain("fmov x0, d0\nfmov d0, x0");
	} finally {
		set_float_forwarding_enabled(true);
	}
});

test("behavioral: forwarded float math stays exact", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func hyp = (float a, float b, out float) {
	var float d = a - b
	return Math.sqrt(d * d)
}

pub func main = () {
	Console.write("\\{hyp(9.0, 4.0)}")
	Console.write("\\n")
	Console.write("\\{hyp(4.0, 9.0)}")
	Console.write("\\n")
}
`,
		"float_forward_pipeline",
		"5.000000\n5.000000",
		true,
	);
});
