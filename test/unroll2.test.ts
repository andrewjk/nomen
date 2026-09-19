import { expect, test } from "vite-plus/test";

import {
	loop2_unroll_enabled,
	set_loop2_unroll_enabled,
	unroll_loops_x2,
} from "../src/build_aarch64/asm_unroll2";
import { validate_asm } from "../src/build_aarch64/lift_asm";
import build_and_check_output from "./build_and_check_output";

/**
 * ×2 loop unrolling in validated cycles (ASM_PLAN_7 tranche 8). The
 * header label moves below a pre-guard copy, and [guard, body] duplicate
 * before the back-edge — every guard instance is the original text
 * evaluated at the same sequential point, both copies keep their own
 * `j += m`, and trip counts 0/1/odd/even all execute the identical
 * iteration sequence.
 */

function unroll(lines: string[]): string[] {
	const out = unroll_loops_x2(lines.join("\n"));
	expect(validate_asm(out)).toEqual([]);
	return out.split("\n").filter((l) => l.trim() !== "");
}

const SUM_LOOP = [
	"f:",
	"mov x8, #0",
	"mov x24, #0",
	".while_0:",
	"cmp x24, x25",
	"b.ge .end_while_0",
	"ldr x0, [x9, x24, lsl #3]",
	"add x8, x8, x0",
	".while_update_0:",
	"add x24, x24, #1",
	"b .while_0",
	".end_while_0:",
	"ret",
];

test("the cycle duplicates body and guard exactly once", () => {
	const out = unroll(SUM_LOOP);
	// pre-guard + original + duplicate = 3 guard instances
	expect(out.filter((l) => l === "cmp x24, x25").length).toBe(3);
	// both copies keep their own increment — final j is bit-identical
	expect(out.filter((l) => l === "add x24, x24, #1").length).toBe(2);
	// two body copies
	expect(out.filter((l) => l === "ldr x0, [x9, x24, lsl #3]").length).toBe(2);
	// the untargeted update marker is not duplicated
	expect(out.filter((l) => l === ".while_update_0:").length).toBe(1);
});

test("the header label sits below the pre-guard", () => {
	const out = unroll(SUM_LOOP);
	const text = out.join("\n");
	const preguard = text.indexOf("cmp x24, x25");
	const label = text.indexOf(".while_0:");
	expect(preguard).toBeGreaterThanOrEqual(0);
	expect(preguard).toBeLessThan(label);
	// the back-edge still targets the (moved) label
	expect(text).toContain("b .while_0");
	expect(text.indexOf("b .while_0")).toBeGreaterThan(label);
});

test("a body with a call refuses the unroll", () => {
	const asm = [
		"mov x8, #0",
		".while_0:",
		"cmp x24, x25",
		"b.ge .end_while_0",
		"bl _strlen",
		"add x8, x8, x0",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	].join("\n");
	expect(unroll_loops_x2(asm)).toBe(asm);
});

test("a body with an inner diamond (targeted label) refuses", () => {
	const asm = [
		"mov x8, #0",
		".while_0:",
		"cmp x24, x25",
		"b.ge .end_while_0",
		"cbz x5, else_0",
		"add x8, x8, x24",
		"else_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	].join("\n");
	expect(unroll_loops_x2(asm)).toBe(asm);
});

test("a huge body refuses the unroll", () => {
	const body: string[] = [];
	for (let i = 0; i < 40; i++) body.push(`add x8, x8, #${i + 1}`);
	const asm = [
		"mov x8, #0",
		".while_0:",
		"cmp x24, x25",
		"b.ge .end_while_0",
		...body,
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	].join("\n");
	expect(unroll_loops_x2(asm)).toBe(asm);
});

test("kill-switch restores the text byte-identically", () => {
	const asm = SUM_LOOP.join("\n");
	const saved = loop2_unroll_enabled();
	set_loop2_unroll_enabled(false);
	try {
		expect(unroll_loops_x2(asm)).toBe(asm);
	} finally {
		set_loop2_unroll_enabled(saved);
	}
});

test("behavioral: unrolled loop prints exact sums (both backends)", async () => {
	await build_and_check_output(
		`
import System

func weighted = (int n) {
	var acc = 0
	var i = 0
	while i < n; i += 1 {
		acc = acc + i * 2
	}
	Console.write("\\{acc} ")
}

pub func main = (Init init) {
	weighted(0)
	weighted(1)
	weighted(4)
	weighted(5)
	Console.write("")
}
`,
		"unroll2",
		"0 0 12 20 ",
		true,
	);
});
