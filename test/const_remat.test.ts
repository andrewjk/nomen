import { expect, test } from "vite-plus/test";

import {
	const_remat_enabled,
	fmov_encodable,
	rematerialize_constants,
	set_const_remat_enabled,
} from "../src/build_aarch64/asm_remat";
import { validate_asm } from "../src/build_aarch64/lift_asm";
import build_and_check_output from "./build_and_check_output";

/**
 * Constant rematerialization (ASM_PLAN_7 tranche 4). The spectral-norm
 * receipt: `adr x3, _float_op_4; ldr d18, [x3]` EVERY iteration for the
 * literal `1.0` where clang materializes `fmov d0, #1.0` once. Three
 * rewrites — float pair collapse (liveness-gated), in-cycle fmov hoist
 * to the preheader under a fresh d-register, and movz-range int
 * literal-pool loads — plus the guard rails discovered landing them:
 * only the compiler's `_float_(op|const|lit)_N` pools qualify (a
 * top-level `var float f` also emits a `.double` line named after the
 * variable — collapsing its loads would freeze the variable).
 */

function remat(lines: string[]): string[] {
	const out = rematerialize_constants(lines.join("\n"));
	expect(validate_asm(out)).toEqual([]);
	return out.split("\n").filter((l) => l.trim() !== "");
}

const SPECTRAL_LOOP = [
	"f:",
	"mov x12, #1",
	"mov x24, #0",
	"mov x25, #0",
	"_float_op_4: .double 1.0",
	".while_0:",
	"cmp x24, x26",
	"b.ge .end_while_0",
	"adr x3, _float_op_4",
	"ldr d18, [x3]",
	"fmov d0, x25",
	"scvtf d0, d0",
	"fdiv d17, d18, d0",
	"ldr d0, [x9, x24, lsl #3]",
	"fmul d16, d17, d0",
	"fadd d8, d8, d16",
	".while_update_0:",
	"add x24, x24, #1",
	"b .while_0",
	".end_while_0:",
	"mov x0, x25",
	"ret",
];

test("the pool pair collapses and hoists once before the header", () => {
	const out = remat(SPECTRAL_LOOP);
	const text = out.join("\n");
	// The once-only materialization sits before the header label.
	const hoist_at = text.indexOf("fmov d19, #1.0");
	const header_at = text.indexOf(".while_0:");
	expect(hoist_at).toBeGreaterThan(-1);
	expect(hoist_at).toBeLessThan(header_at);
	// No pool address/load survives in the loop; the consumers read the
	// hoisted register.
	expect(text).not.toContain("adr x3");
	expect(text).not.toContain("ldr d18");
	expect(text).toContain("fdiv d17, d19, d0");
	// The .double data line itself stays (the label is still defined).
	expect(text).toContain("_float_op_4: .double 1.0");
});

test("the consume-and-redefine shape renames only the read operand", () => {
	// `fdiv d17, d17, d0` reads the constant into its own destination —
	// the dest position must keep d17 while the source becomes d19.
	const out = remat(SPECTRAL_LOOP);
	const fdiv = out.find((l) => l.startsWith("fdiv d17"));
	expect(fdiv).toBe("fdiv d17, d19, d0");
});

test("kill-switch restores the text byte-identically", () => {
	const asm = SPECTRAL_LOOP.join("\n");
	const saved = const_remat_enabled();
	set_const_remat_enabled(false);
	try {
		expect(rematerialize_constants(asm)).toBe(asm);
	} finally {
		set_const_remat_enabled(saved);
	}
});

test("a non-encodable literal keeps its pool load", () => {
	const asm = [
		"f:",
		"_float_op_0: .double 3.14",
		"adr x3, _float_op_0",
		"ldr d17, [x3]",
		"fdiv d17, d17, d0",
		"ret",
	].join("\n");
	expect(rematerialize_constants(asm)).toBe(asm);
});

test("a variable-named .double label is never treated as a constant", () => {
	// A top-level `var float f` emits `f: .double …`; its adr+ldr pair is
	// a MUTABLE load — collapsing it would freeze the variable.
	const asm = ["f:", "f: .double 1.0", "adr x0, f", "ldr d0, [x0]", "fmov d8, d0", "ret"].join(
		"\n",
	);
	expect(rematerialize_constants(asm)).toBe(asm);
});

test("a staging register still read after the pair refuses the collapse", () => {
	const asm = [
		"f:",
		"_float_op_0: .double 1.0",
		"adr x3, _float_op_0",
		"ldr d17, [x3]",
		"str x3, [x29, #16]",
		"ret",
	].join("\n");
	const out = rematerialize_constants(asm);
	// The address escapes into the store — the adr must stay.
	expect(out).toContain("adr x3, _float_op_0");
});

test("the FP immediate set gates exactly", () => {
	expect(fmov_encodable(1.0)).toBe(true);
	expect(fmov_encodable(0.0)).toBe(true);
	expect(fmov_encodable(-0.5)).toBe(true);
	expect(fmov_encodable(10.0)).toBe(true);
	expect(fmov_encodable(1.0625)).toBe(true);
	expect(fmov_encodable(256.0)).toBe(false);
	expect(fmov_encodable(3.14)).toBe(false);
	expect(fmov_encodable(-0.0)).toBe(false);
	expect(fmov_encodable(Number.NaN)).toBe(false);
});

test("an in-cycle fmov whose consumer is split by a label refuses the hoist", () => {
	const asm = [
		"f:",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"fmov d18, #1.0",
		"cbz x5, else_0",
		"fmul d16, d18, d0",
		"b end_0",
		"else_0:",
		"fmul d16, d18, d1",
		"end_0:",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	].join("\n");
	const out = rematerialize_constants(asm);
	// A path reaching each consumer may have skipped the fmov, and there
	// d18 held something else — no safe hoist.
	expect(out).toContain("fmov d18, #1.0");
	expect(out).not.toContain("fmul d16, d19");
});

test("movz-range literal-pool loads become mov immediates", () => {
	const out = remat([
		"f:",
		"ldr x0, =5",
		"ldr x19, =-7",
		"ldr x20, =100000",
		"add x0, x0, #1",
		"ret",
	]);
	expect(out).toContain("mov x0, #5");
	expect(out).toContain("mov x19, #-7");
	// Out of movz/movn range: the literal pool stays.
	expect(out).toContain("ldr x20, =100000");
});

test("behavioral: rematerialized float loop constants (both backends)", async () => {
	await build_and_check_output(
		`
import System

func half_sum = (float x, int n, out float) {
	var float acc = 0.0
	var int i = 0
	while i < n; i += 1 {
		acc = acc + 0.5 * x
	}
	return acc
}

pub func main = (Init init) {
	Console.write("\\{half_sum(2.0, 4)}\\n")
}
`,
		"const_remat",
		"4.000000\n",
		true,
	);
});
