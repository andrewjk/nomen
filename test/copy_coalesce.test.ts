import { expect, test } from "vite-plus/test";

import {
	coalesce_copies,
	copy_coalescing_enabled,
	set_copy_coalescing_enabled,
} from "../src/build_aarch64/asm_coalesce";
import { validate_asm } from "../src/build_aarch64/lift_asm";

/**
 * Copy coalescing + derivation memoization (ASM_PLAN_4 item 2, tranche 1):
 * within a straight-line region, `mov xD, xS` copies propagate into read
 * operands and the flagged moves die; the receiver-path derivation
 * `mov xA, xB; add xA, xA, #o1; ldr xA, [xA, #o2]` is memoized and a later
 * identical sequence is deleted outright — the flag-form carry `if` between
 * two accessor statements emits no branch, so the accessor pair shares one
 * straight-line region the statement-level staging pins cannot span.
 */

function coalesce(asm: string[]): string[] {
	const out = coalesce_copies(asm.join("\n"));
	expect(validate_asm(out)).toEqual([]);
	return out.split("\n").filter((l) => l.trim() !== "");
}

test("copy propagates into a read and the dead move is deleted", () => {
	const out = coalesce(["_f:", "mov x15, x0", "adds x12, x15, x3", "ret"]);
	expect(out).toContain("adds x12, x0, x3");
	expect(out).not.toContain("mov x15, x0");
});

test("a source redefinition kills the alias — the physical home still reads", () => {
	const out = coalesce(["_f:", "mov x15, x0", "mul x0, x25, x12", "adds x12, x15, x0", "ret"]);
	// x0 was redefined by the mul, so the adds must keep reading the
	// physical x15 (the move already executed) — no substitution, no delete.
	expect(out).toContain("mov x15, x0");
	expect(out).toContain("adds x12, x15, x0");
});

test("receiver-path derivation is deleted at the second access", () => {
	const out = coalesce([
		"_f:",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		"mov x11, x9",
		"ldr x0, [x11, x10, lsl #3]",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		"mov x11, x9",
		"str x2, [x11, x10, lsl #3]",
		"ret",
	]);
	// The second derivation is redundant: x9/x11 still hold the pointer.
	expect(out.filter((l) => l.startsWith("add x9, ") && l.endsWith(", #24")).length).toBe(1);
	// Both accesses read the first derivation's register.
	expect(out).toContain("ldr x0, [x9, x10, lsl #3]");
	expect(out).toContain("str x2, [x9, x10, lsl #3]");
});

test("a store through a register kills the memo — the re-derivation stays", () => {
	const out = coalesce([
		"_f:",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		"mov x11, x9",
		"str x5, [x11, x10, lsl #3]",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		"mov x11, x9",
		"ret",
	]);
	// The store may alias the loaded cell: both derivations survive.
	expect(out.filter((l) => l.startsWith("add x9, ") && l.endsWith(", #24")).length).toBe(2);
});

test("a label between derivations kills the memo", () => {
	const out = coalesce([
		"_f:",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		".join_1:",
		"mov x11, x9",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		"mov x11, x9",
		"ret",
	]);
	expect(out.filter((l) => l.startsWith("add x9, ") && l.endsWith(", #24")).length).toBe(2);
});

test("a call between derivations kills the memo", () => {
	const out = coalesce([
		"_f:",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		"bl _ensure",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		"mov x11, x9",
		"ret",
	]);
	expect(out.filter((l) => l.startsWith("add x9, ") && l.endsWith(", #24")).length).toBe(2);
});

test("shifted ALU operands are never rewritten (round-trip guard)", () => {
	const out = coalesce(["_f:", "mov x23, x1", "add x25, x9, x1, lsl #6", "ret"]);
	// The lift loses the shift qualifier — the round-trip guard must keep
	// the original text, or the stride scaling would silently vanish.
	expect(out).toContain("add x25, x9, x1, lsl #6");
	expect(out).toContain("mov x23, x1");
});

test("kill-switch restores the text byte-identically", () => {
	const asm = [
		"_f:",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		"mov x11, x9",
		"ldr x0, [x11, x10, lsl #3]",
		"mov x9, x22",
		"add x9, x9, #24",
		"ldr x9, [x9, #8]",
		"mov x11, x9",
		"str x2, [x11, x10, lsl #3]",
		"ret",
	].join("\n");
	const saved = copy_coalescing_enabled();
	set_copy_coalescing_enabled(false);
	try {
		expect(coalesce_copies(asm)).toBe(asm);
	} finally {
		set_copy_coalescing_enabled(saved);
	}
});

test("behavioral: limb loop with carry ifs prints exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

pub func main = () {
	var buf = Buffer<uint64>()
	buf.alloc_int(8)
	var carry = 0
	var i = 0
	while i < 6; i += 1 {
		const uint64 v = buf.load_int(i) as uint64
		const uint64 sum = v + (5 as uint64)
		if sum < v {
			carry += 1
		}
		buf.store_int(i, sum as int)
	}
	Console.write("\\{buf.load_int(0)} \\{buf.load_int(5)} \\{carry}")
}
`,
		"copy_coalesce_limbs",
		"5 5 0",
		true,
	);
});
