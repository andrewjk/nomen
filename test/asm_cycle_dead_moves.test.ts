import { expect, test } from "vite-plus/test";

import {
	eliminate_dead_cycle_moves,
	set_cycle_dead_moves_enabled,
} from "../src/build_aarch64/asm_cycle_dead_moves";
import { validate_asm } from "../src/build_aarch64/lift_asm";

/**
 * Dead staging-move elimination inside validated cycles (ASM_PLAN_6
 * tranche 4): a `mov xD, xS` whose destination exact-CFG liveness proves
 * dead is deleted — but only inside innermost call-free loop cycles. The
 * D4-multiply cycle's five staging leftovers are the reference shape.
 */

function prune(asm: string[]): string[] {
	const out = eliminate_dead_cycle_moves(asm.join("\n"));
	expect(validate_asm(out)).toEqual([]);
	return out.split("\n").filter((l) => l.trim() !== "");
}

const MI_LIKE_LOOP = [
	"f:",
	"stp x29, x30, [sp, #-16]!",
	".while_0:",
	"mov x2, x23",
	"ldr x1, [x29, #336]",
	"cmp x1, x23",
	"b.ge .end_while_0",
	"ldr x10, [x29, #336]",
	"add x9, x22, #24",
	"ldr x9, [x9, #8]",
	"ldr x0, [x9, x10, lsl #3]",
	"mov x12, x0",
	"mul x0, x27, x0",
	"mov x1, x27",
	"mov x0, x19",
	"umulh x0, x27, x12",
	"mov x14, x0",
	"adds x12, x13, x28",
	"cinc x28, x0, hs",
	"mov x2, x12",
	"ldr x3, [x29, #336]",
	"add x10, x16, x3",
	"mov x11, x9",
	"str x12, [x9, x10, lsl #3]",
	".while_update_0:",
	"add x1, x29, #336",
	"ldr x1, [x29, #336]",
	"mov x0, #1",
	"add x0, x1, x0",
	"add x1, x29, #336",
	"str x0, [x29, #336]",
	"b .while_0",
	".end_while_0:",
	"str x14, [x29, #512]",
	"ret",
];

test("mi-loop staging leftovers are pruned, live staging kept", () => {
	const out = prune(MI_LIKE_LOOP);
	const text = out.join("\n");
	// The guard compare reads x23 directly; the umulh reads x27; the
	// store reads x12; x11 is never read at all.
	expect(text).not.toContain("mov x2, x23");
	expect(text).not.toContain("mov x1, x27");
	expect(text).not.toContain("mov x0, x19");
	expect(text).not.toContain("mov x2, x12");
	expect(text).not.toContain("mov x11, x9");
	// These feed real consumers — they stay.
	expect(text).toContain("mov x12, x0");
	expect(text).toContain("mov x14, x0");
	expect(text).toContain("str x12, [x9, x10, lsl #3]");
});

test("a value escaping through the loop exit keeps its move", () => {
	// x14 is read just after the exit label (the si2 base read): the
	// exact CFG liveness must keep the defining move while a dead
	// neighbor dies.
	const out = prune([
		"f:",
		"stp x29, x30, [sp, #-16]!",
		".while_0:",
		"cmp x28, x23",
		"b.ge .end_while_0",
		"umulh x0, x27, x12",
		"mov x14, x0",
		"mov x11, x9",
		"adds x12, x13, x28",
		"cinc x28, x0, hs",
		"str x12, [x9, x10, lsl #3]",
		".while_update_0:",
		"add x28, x28, #1",
		"b .while_0",
		".end_while_0:",
		"str x14, [x29, #512]",
		"ret",
	]);
	const text = out.join("\n");
	expect(text).toContain("mov x14, x0");
	expect(text).not.toContain("mov x11, x9");
});

test("chained dead moves die through the fixpoint", () => {
	const out = prune([
		"f:",
		"stp x29, x30, [sp, #-16]!",
		".while_0:",
		"cmp x28, x23",
		"b.ge .end_while_0",
		"mov x5, x6",
		"mov x4, x5",
		"add x28, x28, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	const text = out.join("\n");
	expect(text).not.toContain("mov x4, x5");
	expect(text).not.toContain("mov x5, x6");
});

test("a w-sibling read keeps the x-def staging mov", () => {
	// The buffer_uint32 receipt: `str w2, [...]` consumes the x2 def's
	// low half — pruning `mov x2, x0` stored garbage every iteration.
	const out = prune([
		"f:",
		"stp x29, x30, [sp, #-16]!",
		".while_0:",
		"mov x2, #4",
		"cmp x24, x2",
		"b.ge .end_while_0",
		"mov x0, #7",
		"mul x0, x24, x0",
		"and x0, x0, #0xFFFFFFFF",
		"mov x2, x0",
		"str w2, [x23, x24, lsl #2]",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	expect(out.join("\n")).toContain("mov x2, x0");
});

test("a call inside the cycle refuses the whole cycle", () => {
	const out = prune([
		"f:",
		"stp x29, x30, [sp, #-16]!",
		".while_0:",
		"mov x11, x9",
		"bl _helper",
		"str x12, [x9, x10, lsl #3]",
		".while_update_0:",
		"add x28, x28, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	expect(out.join("\n")).toContain("mov x11, x9");
});

test("numeric local labels (1f/1b) resolve and the cycle still prunes", () => {
	// validate_asm has a pre-existing gap on raw-block numeric labels, so
	// this shape checks the pass directly.
	const asm = [
		"f:",
		"stp x29, x30, [sp, #-16]!",
		"1:",
		"mov x11, x9",
		"cmp x1, x2",
		"b.hs 2f",
		"str x12, [x9, x10, lsl #3]",
		"b 1b",
		"2:",
		"ret",
	].join("\n");
	const out = eliminate_dead_cycle_moves(asm);
	expect(out).not.toContain("mov x11, x9");
	expect(out).toContain("str x12, [x9, x10, lsl #3]");
});

test("fall-through marker labels inside the cycle do not block pruning", () => {
	// `.while_update_N:` is not a jump target — the cycle survives it.
	const out = prune(MI_LIKE_LOOP);
	expect(out.join("\n")).toContain(".while_update_0:");
	expect(out.join("\n")).not.toContain("mov x11, x9");
});

test("an interior label that is a jump target blocks the cycle", () => {
	const out = prune([
		"f:",
		"stp x29, x30, [sp, #-16]!",
		".while_0:",
		"mov x11, x9",
		"cmp x1, x2",
		"b.hs .inner",
		"str x12, [x9, x10, lsl #3]",
		".inner:",
		"add x28, x28, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	expect(out.join("\n")).toContain("mov x11, x9");
});

test("kill-switch restores the text byte-identically", () => {
	const asm = MI_LIKE_LOOP.join("\n");
	set_cycle_dead_moves_enabled(false);
	try {
		expect(eliminate_dead_cycle_moves(asm)).toBe(asm);
	} finally {
		set_cycle_dead_moves_enabled(true);
	}
	// Sanity: the enabled pass still transforms.
	expect(eliminate_dead_cycle_moves(asm)).not.toBe(asm);
});

test("behavioral: uint32 store loop keeps staging through w views (both backends)", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// The buffer_uint32 receipt as a program: the store's value staging
	// rides a w-sibling read inside the promoted cycle.
	await build_and_check_output(
		`
import System

pub func main = () {
	var Buffer<uint32> b = Buffer<uint32>()
	b.alloc(4)
	var i = 0
	while i < 4; i += 1 {
		b.store(i, (i * 7) as uint32)
	}
	Console.write("\\{b.load(3)}\\n")
	Console.write("\\{b.load(0)}\\n")
}
`,
		"cycle_dead_moves_uint32",
		"21\n0\n",
		true,
	);
});

test("behavioral: bigint-style multiply loop prints exact digits (both backends)", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// A long multiply-accumulate over a Buffer<uint64>: every cycle in
	// the lowering gets staging-leftover pruning, so the arithmetic must
	// stay exact through hundreds of iterations.
	await build_and_check_output(
		`
import System

pub func main = () {
	var Buffer<uint64> buf = Buffer<uint64>()
	buf.alloc_int(4)
	buf.store_int(0, 0)
	buf.store_int(1, 0)
	buf.store_int(2, 0)
	buf.store_int(3, 0)
	var carry = 0
	var i = 0
	while i < 300; i += 1 {
		const uint64 v = buf.load_int(0) as uint64
		const uint64 sum = v + (4294967295 as uint64)
		if sum < v {
			carry += 1
		}
		buf.store_int(0, sum as int)
		buf.store_int(1, (buf.load_int(1) as uint64 + 3 as uint64) as int)
	}
	Console.write("\\{carry} \\{buf.load_int(0)} \\{buf.load_int(1)}")
}
`,
		"cycle_dead_moves_muladd",
		"0 1288490188500 900",
		true,
	);
});
