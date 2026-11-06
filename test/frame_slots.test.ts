import { describe, expect, test } from "vite-plus/test";

import { optimize_frame_slots } from "../src/build_aarch64/asm_opt";
import { validate_asm } from "../src/build_aarch64/lift_asm";

function opt(asm: string): string[] {
	const out = optimize_frame_slots(asm);
	expect(validate_asm(out)).toEqual([]);
	return out.split("\n").filter((l) => l.trim() !== "");
}

describe("frame-slot optimization", () => {
	test("store then load forwards to a mov", () => {
		const out = opt(["_f:", "str x1, [x29, #40]", "ldr x0, [x29, #40]", "ret"].join("\n"));
		// The load becomes mov x0, x1; the store is materialized at the ret
		// boundary (later code may read it).
		expect(out).toContain("mov x0, x1");
	});

	test("dead store dropped when overwritten before any read", () => {
		const out = opt(
			[
				"_f:",
				"mov x1, #1",
				"str x1, [x29, #40]",
				"mov x0, #2",
				"str x0, [x29, #40]",
				"ldr x5, [x29, #40]",
				"ret",
			].join("\n"),
		);
		// First str is dead (overwritten); second is forwarded to the load.
		expect(out.filter((l) => l.startsWith("str")).length).toBe(1);
		expect(out).toContain("mov x5, x0");
	});

	test("store whose source is redefined materializes before the redefinition", () => {
		const out = opt(
			["_f:", "mov x1, #1", "str x1, [x29, #40]", "mov x1, #2", "ldr x0, [x29, #40]", "ret"].join(
				"\n",
			),
		);
		// The store must execute while x1 still holds 1 — emitting it after
		// the mv would store 2.
		const store_idx = out.findIndex((l) => l === "str x1, [x29, #40]");
		const redef_idx = out.findIndex((l) => l === "mov x1, #2");
		expect(store_idx).toBeGreaterThan(-1);
		expect(store_idx < redef_idx).toBe(true);
	});

	test("redundant load coalesced to mov", () => {
		const out = opt(
			["_f:", "ldr x0, [x29, #40]", "ldr x1, [x29, #40]", "add x2, x0, x1", "ret"].join("\n"),
		);
		expect(out.filter((l) => l.startsWith("ldr")).length).toBe(1);
		expect(out).toContain("mov x1, x0");
	});

	test("address idiom add+load normalized and forwarded", () => {
		const out = opt(
			["_f:", "str x3, [x29, #40]", "add x9, x29, #40", "ldr x0, [x9]", "ret"].join("\n"),
		);
		// The add stays (the address may feed later reads) but the load is
		// rewritten direct and forwarded from the pending store.
		expect(out).toContain("add x9, x29, #40");
		expect(out).toContain("mov x0, x3");
		expect(out.filter((l) => l.includes("ldr") && l.includes("[x9]")).length).toBe(0);
	});

	test("escaped address disables forwarding", () => {
		// The add feeds something other than a direct access (e.g. memcpy) —
		// the slot may be rewritten behind our back.
		const out = opt(
			[
				"_f:",
				"str x3, [x29, #40]",
				"add x9, x29, #40",
				"bl _memcpy",
				"ldr x0, [x29, #40]",
				"ret",
			].join("\n"),
		);
		expect(out.filter((l) => l === "ldr x0, [x29, #40]").length).toBe(1);
	});

	test("call preserves slot availability in callee-saved registers", () => {
		const out = opt(
			["_f:", "str x19, [x29, #40]", "bl _g", "ldr x0, [x29, #40]", "ret"].join("\n"),
		);
		expect(out).toContain("mov x0, x19");
	});

	test("call kills caller-saved availability", () => {
		const out = opt(["_f:", "str x1, [x29, #40]", "bl _g", "ldr x0, [x29, #40]", "ret"].join("\n"));
		expect(out).toContain("ldr x0, [x29, #40]");
		expect(out).not.toContain("mov x0, x1");
	});

	test("register clobber invalidates availability", () => {
		const out = opt(
			["_f:", "ldr x0, [x29, #40]", "mov x0, #7", "ldr x1, [x29, #40]", "ret"].join("\n"),
		);
		expect(out.filter((l) => l === "ldr x1, [x29, #40]").length).toBe(1);
	});

	test("label boundary flushes pending stores", () => {
		const out = opt(["_f:", "str x0, [x29, #40]", ".Lj:", "ldr x1, [x29, #40]", "ret"].join("\n"));
		// The pending store must be emitted before the join label so the
		// sibling path reads it.
		const label_idx = out.indexOf(".Lj:");
		const store_idx = out.findIndex((l) => l === "str x0, [x29, #40]");
		const load_idx = out.indexOf("ldr x1, [x29, #40]");
		expect(store_idx).toBeGreaterThan(-1);
		expect(store_idx < label_idx && label_idx < load_idx).toBe(true);
	});

	test("width-mismatched access is not forwarded", () => {
		const out = opt(["_f:", "str x1, [x29, #40]", "ldrb w0, [x29, #40]", "ret"].join("\n"));
		expect(out).toContain("ldrb w0, [x29, #40]");
	});

	test("float literal initializer survives a later same-register reload", () => {
		// `var float f = 7.5; f = f / 2.5`: the initializer store is pending
		// when the assignment reads the slot back into d0. The load must not
		// let the store-store kill drop the initializer — the register still
		// holds the stored bits, so the reload is elided and the store is
		// committed first.
		const out = opt(
			[
				"_f:",
				"fmov d0, #7.5",
				"str d0, [x29, #0]",
				"fmov d1, #2.5",
				"ldr d0, [x29, #0]",
				"fdiv d0, d0, d1",
				"str d0, [x29, #0]",
				"ret",
			].join("\n"),
		);
		const store_idx = out.indexOf("str d0, [x29, #0]");
		const div_idx = out.indexOf("fdiv d0, d0, d1");
		expect(store_idx).toBeGreaterThan(-1);
		expect(store_idx < div_idx).toBe(true);
		// The same-register reload is elided (d0 already holds 7.5).
		expect(out).not.toContain("ldr d0, [x29, #0]");
	});

	test("load-triggered clobber materializes a pending sub-width store", () => {
		// Same shape at 32-bit width: `fpr32` same-register reloads are not
		// elided (the load zeroes the upper bits), but the load still READS
		// the slot — the pending initializer must reach memory instead of
		// being killed by the store-store heuristic.
		const out = opt(
			[
				"_f:",
				"fmov s0, #1.5",
				"str s0, [x29, #0]",
				"ldr s0, [x29, #0]",
				"fadd s0, s0, s0",
				"str s0, [x29, #0]",
				"ret",
			].join("\n"),
		);
		const store_idx = out.indexOf("str s0, [x29, #0]");
		const load_idx = out.indexOf("ldr s0, [x29, #0]");
		expect(store_idx).toBeGreaterThan(-1);
		expect(store_idx < load_idx).toBe(true);
		expect(load_idx).toBeGreaterThan(-1);
	});
});
