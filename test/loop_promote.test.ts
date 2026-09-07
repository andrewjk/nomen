import { expect, test } from "vite-plus/test";

import {
	loop_slot_promotion_enabled,
	promote_loop_slots,
	set_loop_slot_promotion_enabled,
} from "../src/build_aarch64/asm_loop_promote";
import { validate_asm } from "../src/build_aarch64/lift_asm";

/**
 * Loop-carried slot promotion (ASM_PLAN_4 item 2, tranche 2): an
 * innermost call-free loop's read+write frame slot (the carry the
 * allocator cannot hold — live into the header, low raw reads,
 * function-wide pool exhaustion) is renamed into a caller-saved scratch
 * register for the whole cycle, syncing at the entry and the exits, and
 * the flag-form carry increment `cset xT, cc … add xA, xA, xT … mov xH,
 * xA` collapses to `cinc xH, xH, cc`.
 */

function promote(asm: string[]): string[] {
	const out = promote_loop_slots(asm.join("\n"));
	expect(validate_asm(out)).toEqual([]);
	return out.split("\n").filter((l) => l.trim() !== "");
}

const CARRY_LOOP = [
	"div_to:",
	"stp x29, x30, [sp, #-16]!",
	".while_24:",
	"cmp x28, x23",
	"b.ge .end_while_24",
	"ldr x0, [x29, #288]",
	"adds x12, x15, x0",
	"str x14, [x29, #288]",
	"cset x0, hs",
	"ldr x1, [x29, #288]",
	"add x1, x1, x0",
	"str x1, [x29, #288]",
	".while_update_24:",
	"add x28, x28, #1",
	"b .while_24",
	".end_while_24:",
	"str x1, [x29, #288]",
	"ret",
];

test("carry slot renames into x16 with entry load and exit sync", () => {
	const out = promote(CARRY_LOOP);
	// Entry load before the header (fall-through only).
	expect(out).toContain("ldr x16, [x29, #288]");
	// Every cycle access is a register move now.
	expect(
		out.filter(
			(l) => l.includes("[x29, #288]") && !l.startsWith("ldr x16") && !l.startsWith("str x16"),
		).length,
	).toBe(1);
	// The remaining slot access is the post-loop read, after the sync.
	const sync_at = out.indexOf("str x16, [x29, #288]");
	const post_at = out.indexOf("str x1, [x29, #288]");
	expect(sync_at).toBeGreaterThan(-1);
	expect(post_at).toBeGreaterThan(sync_at);
	// The carry increment collapsed.
	expect(out).toContain("cinc x16, x16, hs");
	expect(out).not.toContain("cset x0, hs");
});

test("cycles without exit targets are left alone", () => {
	const out = promote([
		"_f:",
		".while_0:",
		"ldr x3, [x29, #264]",
		"add x10, x26, x3",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	expect(out).toContain("ldr x3, [x29, #264]");
	expect(out).not.toContain("x16");
});

test("read-only slot renames into x17 with an entry load and NO sync", () => {
	// The ASM_PLAN_6 tranche-1 shape: the hoisted invariant index base
	// (`_vn` temp) reads its slot every iteration but never writes it —
	// the entry load makes x17 the live copy and memory stays
	// authoritative outside (no exit sync needed). The write-slot carry
	// takes x16 (and its sync) first.
	const out = promote([
		"f:",
		".while_0:",
		"cmp x28, x23",
		"b.ge .end_while_0",
		"ldr x10, [x29, #528]",
		"add x10, x10, x28",
		"str x12, [x10]",
		"ldr x1, [x29, #320]",
		"adds x12, x13, x1",
		"cset x0, hs",
		"add x1, x1, x0",
		"str x1, [x29, #320]",
		".while_update_0:",
		"add x28, x28, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	// The base renamed to x17: entry load, register reads, no sync.
	expect(out).toContain("ldr x17, [x29, #528]");
	expect(out).toContain("mov x10, x17");
	expect(out).not.toContain("str x17, [x29, #528]");
	// The carry keeps the write-slot behavior: x16 with an exit sync.
	expect(out).toContain("ldr x16, [x29, #320]");
	expect(out).toContain("str x16, [x29, #320]");
});

test("an address escape disqualifies the slot", () => {
	const out = promote([
		"_f:",
		"add x9, x29, #288",
		".while_0:",
		"ldr x0, [x29, #288]",
		"str x1, [x29, #288]",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	// The slot is reachable through the register — no promotion.
	expect(out).toContain("ldr x0, [x29, #288]");
});

test("a call inside the cycle blocks promotion", () => {
	const out = promote([
		"_f:",
		".while_0:",
		"bl _helper",
		"ldr x0, [x29, #288]",
		"str x1, [x29, #288]",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	expect(out).toContain("ldr x0, [x29, #288]");
	expect(out).not.toContain("ldr x16");
});

test("sub-width accesses disqualify the slot", () => {
	const out = promote([
		"_f:",
		"strb w5, [x29, #288]",
		".while_0:",
		"ldr x0, [x29, #288]",
		"str x1, [x29, #288]",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	expect(out).toContain("ldr x0, [x29, #288]");
});

test("kill-switch restores the text byte-identically", () => {
	const asm = CARRY_LOOP.join("\n");
	const saved = loop_slot_promotion_enabled();
	set_loop_slot_promotion_enabled(false);
	try {
		expect(promote_loop_slots(asm)).toBe(asm);
	} finally {
		set_loop_slot_promotion_enabled(saved);
	}
});

test("behavioral: BigInt-style carry loop prints exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// 200 limbs of 9s + one wrap: the carry propagates through every
	// iteration of the promoted loop.
	await build_and_check_output(
		`
import System

pub func main = () {
	var buf = Buffer<uint64>()
	buf.alloc_int(8)
	buf.store_int(0, -1)
	var carry = 0
	var i = 0
	while i < 6; i += 1 {
		const uint64 v = buf.load_int(i) as uint64
		const uint64 sum = v + (1 as uint64)
		if sum < v {
			carry += 1
		}
		buf.store_int(i, sum as int)
	}
	Console.write("\\{carry} \\{buf.load_int(1)}")
}
`,
		"loop_promote_carry",
		"1 1",
		true,
	);
});

test("derivation pair hoists into a promotion register", () => {
	// The ASM_PLAN_6 tranche-2 shape: the Buffer receiver derivation
	// (`add x9, x22, #24 / ldr x9, [x9, #8]`) recomputes digits.data
	// every iteration. In a call-free cycle the field cannot change
	// (ensure/grow are calls), so the pair hoists into the leftover
	// promotion register and every pointer use renames.
	const out = promote([
		"f:",
		".while_0:",
		"cmp x28, x23",
		"b.ge .end_while_0",
		"add x9, x22, #24",
		"ldr x9, [x9, #8]",
		"ldr x0, [x9, x28, lsl #3]",
		"mov x11, x9",
		"str x12, [x9, x10, lsl #3]",
		".while_update_0:",
		"add x28, x28, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	// The pair is gone from the cycle; the entry recomputes into x16.
	expect(out.join("\n")).toContain("add x16, x22, #24\nldr x16, [x16, #8]");
	expect(out.filter((l) => l.includes("add x9, x22")).length).toBe(0);
	// The pointer uses renamed.
	expect(out).toContain("ldr x0, [x16, x28, lsl #3]");
	expect(out).toContain("mov x11, x16");
	expect(out).toContain("str x12, [x16, x10, lsl #3]");
});

test("a second definition of the derivation target refuses the hoist", () => {
	const out = promote([
		"f:",
		".while_0:",
		"cmp x28, x23",
		"b.ge .end_while_0",
		"add x9, x22, #24",
		"ldr x9, [x9, #8]",
		"mov x9, x20",
		"ldr x0, [x9, x28, lsl #3]",
		".while_update_0:",
		"add x28, x28, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	// x9 has another definition — the pair is not the sole def.
	expect(out).toContain("add x9, x22, #24");
});

test("a write to the source struct field refuses the derivation hoist", () => {
	const out = promote([
		"f:",
		".while_0:",
		"cmp x28, x23",
		"b.ge .end_while_0",
		"add x9, x22, #24",
		"ldr x9, [x9, #8]",
		"str x5, [x22, #24]",
		"ldr x0, [x9, x28, lsl #3]",
		".while_update_0:",
		"add x28, x28, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	// The digits.data field is rewritten in the cycle — the value is not
	// invariant.
	expect(out).toContain("add x9, x22, #24");
});

test("a frame-derived pair (mutable slot) refuses the hoist", () => {
	// The for-of materialisation reads the CURRENT ELEMENT POINTER from a
	// frame slot and dereferences it — the slot advances per iteration,
	// so the pair is not invariant (the arrays.test.ts receipt: summing
	// `p.y` froze on the first element).
	const out = promote([
		"f:",
		".for_0:",
		"ldr x0, [x29, #16]",
		"str x0, [sp, #-16]!",
		"ldr x0, [x29, #0]",
		"ldr x0, [x0]",
		"ldr x1, [sp], #16",
		"cmp x1, x0",
		"bge .end_0",
		"add x16, x29, #24",
		"ldr x16, [x16, #16]",
		"ldr x3, [x16, #8]",
		"add x23, x23, x3",
		"add x0, x29, #24",
		"str x3, [x0, #8]",
		".for_inc_0:",
		"ldr x0, [x29, #16]",
		"add x0, x0, #1",
		"str x0, [x29, #16]",
		"b .for_0",
		".end_0:",
		"ret",
	]);
	// The frame-derived pair stays per-iteration.
	expect(out.filter((l) => l.includes("add x16, x29, #24")).length).toBe(1);
	expect(out).toContain("ldr x3, [x16, #8]");
});
