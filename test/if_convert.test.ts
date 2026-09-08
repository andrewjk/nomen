import { expect, test } from "vite-plus/test";

import {
	convert_loop_invariant_branches,
	if_conversion_enabled,
	set_if_conversion_enabled,
} from "../src/build_aarch64/asm_if_convert";
import { validate_asm } from "../src/build_aarch64/lift_asm";

/**
 * Loop-invariant branch if-conversion inside validated cycles
 * (ASM_PLAN_7 tranche 1): a two-arm if-diamond inside a call-free loop
 * whose arms are identical except ONE operand, with the predicate and
 * both operands never defined in the cycle, merges to a single arm
 * reading a select register materialized once before the header.
 */

function convert(asm: string[]): string[] {
	const out = convert_loop_invariant_branches(asm.join("\n"));
	expect(validate_asm(out)).toEqual([]);
	return out.split("\n").filter((l) => l.trim() !== "");
}

/** The spectral-norm `.while_4` shape: `if transpose` inside the hot j
 *  loop, both arms staging through the push/pop pair, differing only in
 *  the invariant step register (x13 vs x14). */
const SPECTRAL_LOOP = [
	"f:",
	"stp x29, x30, [sp, #-16]!",
	"mov x12, #1",
	"mov x13, #10",
	"mov x14, #20",
	"mov x24, #0",
	"mov x25, #0",
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
	"cmp x12, #0",
	"beq else_0",
	"mov x1, x25",
	"str x1, [sp, #-16]!",
	"add x0, x13, x24",
	"ldr x1, [sp], #16",
	"add x0, x1, x0",
	"mov x25, x0",
	"b end_0",
	"else_0:",
	"mov x1, x25",
	"str x1, [sp, #-16]!",
	"add x0, x14, x24",
	"ldr x1, [sp], #16",
	"add x0, x1, x0",
	"mov x25, x0",
	"end_0:",
	".while_update_0:",
	"add x24, x24, #1",
	"b .while_0",
	".end_while_0:",
	"mov x0, x25",
	"ret",
];

test("the spectral shape hoists a csel before the header and merges the arms", () => {
	const out = convert(SPECTRAL_LOOP);
	const text = out.join("\n");
	// The select materializes once, before the header label.
	const csel_at = text.indexOf("csel x16, x13, x14, ne");
	const header_at = text.indexOf(".while_0:");
	const cmp_at = text.indexOf("cmp x12, #0");
	expect(csel_at).toBeGreaterThan(-1);
	expect(cmp_at).toBeGreaterThan(-1);
	expect(cmp_at).toBeLessThan(csel_at);
	expect(csel_at).toBeLessThan(header_at);
	// The diamond scaffolding is gone; one merged arm reads x16.
	expect(out.filter((l) => l === "cmp x12, #0").length).toBe(1);
	expect(text).not.toContain("beq else_0");
	expect(text).not.toContain("else_0:");
	expect(text).not.toContain("add x0, x13, x24");
	expect(text).not.toContain("add x0, x14, x24");
	expect(out.filter((l) => l === "add x0, x16, x24").length).toBe(1);
	// The end label stays (untargeted fall-through marker).
	expect(text).toContain("end_0:");
	// The select register does not disturb the loop's own registers.
	expect(out.filter((l) => l.includes("x16") && !l.includes("csel")).length).toBe(1);
});

test("a predicate defined in the cycle refuses the conversion", () => {
	const asm = SPECTRAL_LOOP.slice();
	asm.splice(9, 0, "mov x12, x5"); // inside .while_0, after the guard cmp
	const out = convert(asm);
	expect(out.join("\n")).toContain("beq else_0");
	expect(out.join("\n")).not.toContain("csel");
});

test("a differing operand defined in the cycle refuses the conversion", () => {
	const asm = SPECTRAL_LOOP.slice();
	// The then arm's diff line also DEFINES its own diff operand.
	const then_idx = asm.indexOf("add x0, x13, x24");
	asm[then_idx] = "add x13, x13, x24";
	const else_idx = asm.indexOf("add x0, x14, x24");
	asm[else_idx] = "add x13, x14, x24";
	const out = convert(asm);
	expect(out.join("\n")).toContain("beq else_0");
});

test("arms of different lengths refuse the conversion", () => {
	// The .else_7 shape: a one-instruction then arm against a staged
	// six-instruction else arm.
	const asm = [
		"f:",
		"mov x12, #1",
		"mov x23, #0",
		"mov x25, #0",
		".while_0:",
		"cmp x23, x26",
		"b.ge .end_while_0",
		"mul x0, x23, x23",
		"mov x25, x0",
		"cmp x12, #0",
		"beq else_0",
		"add x25, x25, #1",
		"b end_0",
		"else_0:",
		"mov x1, x25",
		"str x1, [sp, #-16]!",
		"add x0, x23, #1",
		"ldr x1, [sp], #16",
		"add x0, x1, x0",
		"mov x25, x0",
		"end_0:",
		".while_update_0:",
		"add x23, x23, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	];
	const out = convert(asm);
	expect(out.join("\n")).toContain("beq else_0");
	expect(out.join("\n")).not.toContain("csel");
});

test("a diamond outside any cycle is left alone", () => {
	const asm = [
		"f:",
		"mov x12, #1",
		"cmp x12, #0",
		"beq else_0",
		"add x0, x13, x1",
		"b end_0",
		"else_0:",
		"add x0, x14, x1",
		"end_0:",
		"ret",
	];
	const out = convert(asm);
	expect(out.join("\n")).toContain("beq else_0");
});

test("an external jump to the end label refuses the conversion", () => {
	const asm = [
		"g:",
		"b end_0",
		"f:",
		"mov x12, #1",
		".while_0:",
		"cmp x12, #0",
		"beq else_0",
		"add x0, x13, x24",
		"mov x25, x0",
		"b end_0",
		"else_0:",
		"add x0, x14, x24",
		"mov x25, x0",
		"end_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	];
	const out = convert(asm);
	expect(out.join("\n")).toContain("beq else_0");
});

test("an external jump to the else label refuses the conversion", () => {
	const asm = [
		"g:",
		"b else_0",
		"f:",
		"mov x12, #1",
		".while_0:",
		"cmp x12, #0",
		"beq else_0",
		"add x0, x13, x24",
		"mov x25, x0",
		"b end_0",
		"else_0:",
		"add x0, x14, x24",
		"mov x25, x0",
		"end_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	];
	const out = convert(asm);
	expect(out.join("\n")).toContain("beq else_0");
});

test("a call inside the cycle refuses the conversion", () => {
	const asm = SPECTRAL_LOOP.slice();
	// Right after the header (before the guard compare, not between a
	// compare and its branch — the lift's flag discipline is real).
	asm.splice(8, 0, "bl _helper");
	asm.push("_helper:", "ret");
	const out = convert(asm);
	expect(out.join("\n")).toContain("beq else_0");
});

test("the cbz test form hoists cmp #0 with a ne select", () => {
	const asm = [
		"f:",
		"mov x12, #1",
		"mov x13, #10",
		"mov x14, #20",
		"mov x24, #0",
		"mov x25, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"cbz x12, else_0",
		"add x0, x13, x24",
		"mov x25, x0",
		"b end_0",
		"else_0:",
		"add x0, x14, x24",
		"mov x25, x0",
		"end_0:",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	];
	const out = convert(asm);
	const text = out.join("\n");
	const cmp_at = text.indexOf("cmp x12, #0");
	const csel_at = text.indexOf("csel x16, x13, x14, ne");
	const header_at = text.indexOf(".while_0:");
	expect(cmp_at).toBeGreaterThan(-1);
	expect(cmp_at).toBeLessThan(csel_at);
	expect(csel_at).toBeLessThan(header_at);
	expect(text).not.toContain("cbz x12");
});

test("immediate-differing arms hoist a once-only mov pair", () => {
	const asm = [
		"f:",
		"mov x12, #1",
		"mov x13, #10",
		"mov x24, #0",
		"mov x25, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"cmp x12, #0",
		"beq else_0",
		"add x0, x13, #2",
		"mov x25, x0",
		"b end_0",
		"else_0:",
		"add x0, x13, #1",
		"mov x25, x0",
		"end_0:",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	];
	const out = convert(asm);
	const text = out.join("\n");
	// The once-only materialization sits before the header; the merged
	// arm reads the select register.
	const header_at = text.indexOf(".while_0:");
	const mov_at = text.indexOf("mov x16, #1");
	const branch_at = text.indexOf("b.eq .ifc_0");
	const mov2_at = text.indexOf("mov x16, #2");
	expect(mov_at).toBeGreaterThan(-1);
	expect(branch_at).toBeGreaterThan(mov_at);
	expect(mov2_at).toBeGreaterThan(branch_at);
	expect(text.indexOf(".ifc_0:", mov2_at)).toBeGreaterThan(-1);
	expect(text.indexOf(".ifc_0:")).toBeLessThan(header_at);
	expect(out.filter((l) => l === "add x0, x13, x16").length).toBe(1);
	expect(text).not.toContain("add x0, x13, #2");
	expect(text).not.toContain("add x0, x13, #1");
	expect(text).not.toContain("beq else_0");
});

test("a select register busy in the cycle moves the choice to the next pool slot", () => {
	const asm = SPECTRAL_LOOP.slice();
	// x16 participates in the loop body (an address temp, say).
	const guard = asm.indexOf("b.ge .end_while_0");
	asm.splice(guard + 1, 0, "mov x16, x24");
	const out = convert(asm);
	expect(out.join("\n")).toContain("csel x17, x13, x14, ne");
	expect(out.join("\n")).toContain("add x0, x17, x24");
});

test("a hex immediate operand is rewritten token-safely", () => {
	const asm = [
		"f:",
		"mov x12, #1",
		"mov x24, #0",
		"mov x25, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"cmp x12, #0",
		"beq else_0",
		"add x0, x24, #0x10",
		"mov x25, x0",
		"b end_0",
		"else_0:",
		"add x0, x24, #0x20",
		"mov x25, x0",
		"end_0:",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	];
	const out = convert(asm);
	const text = out.join("\n");
	expect(out.filter((l) => l === "add x0, x24, x16").length).toBe(1);
	expect(text).toContain("mov x16, #32");
	expect(text).toContain("mov x16, #16");
	expect(text).not.toContain("#0x10");
	expect(text).not.toContain("#0x20");
});

test("kill-switch restores the text byte-identically", () => {
	const asm = SPECTRAL_LOOP.join("\n");
	const saved = if_conversion_enabled();
	set_if_conversion_enabled(false);
	try {
		expect(convert_loop_invariant_branches(asm)).toBe(asm);
	} finally {
		set_if_conversion_enabled(saved);
	}
});

test("two diamonds in one loop both convert across rounds", () => {
	const asm = [
		"f:",
		"mov x12, #1",
		"mov x15, #2",
		"mov x13, #10",
		"mov x14, #20",
		"mov x24, #0",
		"mov x25, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"cmp x12, #0",
		"beq else_0",
		"add x0, x13, x24",
		"mov x25, x0",
		"b end_0",
		"else_0:",
		"add x0, x14, x24",
		"mov x25, x0",
		"end_0:",
		"cmp x12, #0",
		"beq else_1",
		"add x0, x13, #4",
		"mov x15, x0",
		"b end_1",
		"else_1:",
		"add x0, x14, #4",
		"mov x15, x0",
		"end_1:",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	];
	const out = convert(asm);
	const text = out.join("\n");
	expect(text).toContain("csel x16, x13, x14, ne");
	expect(text).toContain("csel x17, x13, x14, ne");
	expect(text).not.toContain("beq else_0");
	expect(text).not.toContain("beq else_1");
	expect(out.filter((l) => l === "add x0, x16, x24").length).toBe(1);
	expect(out.filter((l) => l === "add x0, x17, #4").length).toBe(1);
});

test("behavioral: both select paths compute exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func pick = (int base, int other, int n, bool t) {
	var acc = 0
	var i = 0
	while i < n; i += 1 {
		if t {
			acc += base + i
		} else {
			acc += other + i
		}
	}
	Console.write("\\{acc} ")
}

pub func main = (Init init) {
	pick(10, 100, 3, true)
	pick(10, 100, 3, false)
}
`,
		"if_convert_paths",
		"33 303 ",
		true,
	);
});
