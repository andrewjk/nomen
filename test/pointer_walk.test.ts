import { expect, test } from "vite-plus/test";

import {
	pointer_walk_enabled,
	reduce_pointer_walks,
	set_pointer_walk_enabled,
} from "../src/build_aarch64/asm_pointer_walk";
import { validate_asm } from "../src/build_aarch64/lift_asm";
import build_and_check_output from "./build_and_check_output";

/**
 * Pointer-walk strength reduction (ASM_PLAN_7 tranche 6). Clang's
 * spectral-norm receipt walks the pointer — `ldr d3, [x16], #8`, the
 * index register gone from the memory op entirely. When a validated
 * cycle's induction indexes a loop-invariant base at a fixed scale with
 * EXACTLY ONE access per iteration (no jump-targeted label inside — the
 * access must run unconditionally or the post-index bump desyncs from
 * the induction), the addressing becomes a walked register: preheader
 * `add w, base, j, lsl #k`, body `… [w], #stride`. Vector (q/v) accesses
 * belong to the NEON planner's closed-form loops and are never walked.
 */

function walk(lines: string[]): string[] {
	const out = reduce_pointer_walks(lines.join("\n"));
	expect(validate_asm(out)).toEqual([]);
	return out.split("\n").filter((l) => l.trim() !== "");
}

test("the single-access receipt walks post-index", () => {
	const out = walk([
		"f:",
		"mov x24, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"ldr d0, [x9, x24, lsl #3]",
		"fadd d8, d8, d0",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	const text = out.join("\n");
	// The preheader materializes the walk before the header.
	const init_at = text.indexOf("add x16, x9, x24, lsl #3");
	const header_at = text.indexOf(".while_0:");
	expect(init_at).toBeGreaterThan(-1);
	expect(init_at).toBeLessThan(header_at);
	// The load carries the bump — clang's exact form.
	expect(text).toContain("ldr d0, [x16], #8");
	expect(text).not.toContain("[x9, x24, lsl #3]");
	// The induction itself is untouched (the guard still compares it).
	expect(text).toContain("add x24, x24, #1");
	expect(text).toContain("cmp x24, x26");
});

test("the walk stride tracks the induction increment", () => {
	// j += 2 at scale 8 bytes → the post-index bump is #16.
	const out = walk([
		"f:",
		"mov x25, #0",
		".while_0:",
		"cmp x25, x26",
		"b.ge .end_while_0",
		"ldr x0, [x12, x25, lsl #3]",
		"add x8, x8, x0",
		".while_update_0:",
		"add x25, x25, #2",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	const text = out.join("\n");
	expect(text).toContain("ldr x0, [x16], #16");
	expect(text).toContain("add x16, x12, x25, lsl #3");
});

test("a second access of the same base refuses the walk", () => {
	// Two accesses per iteration: the post-index bump would double-apply.
	const asm = [
		"f:",
		"mov x24, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"ldr x0, [x9, x24, lsl #3]",
		"str x0, [x9, x24, lsl #3]",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	].join("\n");
	expect(reduce_pointer_walks(asm)).toBe(asm);
});

test("an inner diamond (conditional access) refuses the walk", () => {
	const asm = [
		"f:",
		"mov x24, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"cbz x5, else_0",
		"ldr x0, [x9, x24, lsl #3]",
		"add x8, x8, x0",
		"else_0:",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	].join("\n");
	expect(reduce_pointer_walks(asm)).toBe(asm);
});

test("an induction with extra definitions refuses the walk", () => {
	const asm = [
		"f:",
		"mov x24, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"ldr x0, [x9, x24, lsl #3]",
		"add x8, x8, x0",
		"mov x24, x0",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	].join("\n");
	expect(reduce_pointer_walks(asm)).toBe(asm);
});

test("a base redefined in the cycle refuses the walk", () => {
	const asm = [
		"f:",
		"mov x24, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"ldr x0, [x9, x24, lsl #3]",
		"add x8, x8, x0",
		"mov x9, x5",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	].join("\n");
	expect(reduce_pointer_walks(asm)).toBe(asm);
});

test("a walk register needed elsewhere in the function refuses", () => {
	// x16 participates in the loop body (an if-converted select, say) —
	// the pool moves to x17.
	const out = walk([
		"f:",
		"mov x24, #0",
		"cmp x13, x14",
		"csel x16, x13, x14, ne",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"ldr d0, [x9, x24, lsl #3]",
		"fadd d8, d8, d0",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	expect(out.join("\n")).toContain("ldr d0, [x17], #8");
});

test("kill-switch restores the text byte-identically", () => {
	const asm = [
		"f:",
		"mov x24, #0",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"ldr d0, [x9, x24, lsl #3]",
		"fadd d8, d8, d0",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	].join("\n");
	const saved = pointer_walk_enabled();
	set_pointer_walk_enabled(false);
	try {
		expect(reduce_pointer_walks(asm)).toBe(asm);
	} finally {
		set_pointer_walk_enabled(saved);
	}
});

test("behavioral: walked pointer loads exact values (both backends)", async () => {
	await build_and_check_output(
		`
import System

func sum_u64 = (ref Buffer<uint64> a, int n) {
	if n <= a.cap {
		var uint64 acc = 0
		var int i = 0
		while i < n; i += 1 {
			acc = acc + (a.load_int(i) as uint64)
		}
		Console.write("\\{acc}\\n")
	}
}

pub func main = (Init init) {
	var a = Buffer<uint64>()
	a.alloc_int(4)
	var int k = 0
	while k < 4; k += 1 {
		a.store_int(k, k + 1)
	}
	sum_u64(ref a, 4)
}
`,
		"pointer_walk",
		"10\n",
		true,
	);
});
