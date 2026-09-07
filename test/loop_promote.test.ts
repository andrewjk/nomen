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
