import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { optimize_asm } from "../src/build_common/optimize_asm";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("optimize_asm passes", () => {
	test("removes instructions after an unconditional branch until the next label", () => {
		const asm = [
			"_f:",
			"mov x0, #1",
			"b .Lend",
			"mov x0, #2",
			"add x0, x0, #1",
			".Lend:",
			"ret",
		].join("\n");
		// The dead instructions go; the surviving `b .Lend` is itself a
		// branch-to-next and folds away in the next round.
		const out = optimize_asm(asm);
		expect(out).toBe(["_f:", "mov x0, #1", ".Lend:", "ret"].join("\n"));
	});

	test("conditional branches are not terminators — fall-through code stays", () => {
		const asm = ["_f:", "cbz x0, .Lz", "mov x1, #2", "ret", ".Lz:", "ret"].join("\n");
		const out = optimize_asm(asm);
		expect(out).toBe(asm);
	});

	test("removes instructions after ret but keeps directives and labels", () => {
		const asm = ["_f:", "ret", "mov x0, #99", ".p2align 2", "_g:", "mov x0, #1", "ret"].join("\n");
		const out = optimize_asm(asm);
		expect(out).toBe(["_f:", "ret", ".p2align 2", "_g:", "mov x0, #1", "ret"].join("\n"));
	});

	test("drops a branch to the immediately following label", () => {
		const asm = ["_f:", "mov x0, #1", "b .Lnext", ".Lnext:", "ret"].join("\n");
		const out = optimize_asm(asm);
		expect(out).toBe(["_f:", "mov x0, #1", ".Lnext:", "ret"].join("\n"));
	});

	test("keeps a branch when other code sits before the target label", () => {
		const asm = ["_f:", "b .Lend", "mov x0, #2", ".Lend:", "ret"].join("\n");
		const out = optimize_asm(asm);
		// The mov is unreachable and goes away, then the branch-to-next folds.
		expect(out).toBe(["_f:", ".Lend:", "ret"].join("\n"));
	});

	test("drops identity moves", () => {
		const asm = ["_f:", "mov x0, x0", "fmov d3, d3", "mov x1, x0", "ret"].join("\n");
		const out = optimize_asm(asm);
		expect(out).toBe(["_f:", "mov x1, x0", "ret"].join("\n"));
	});

	test("keeps adjacent str/ldr pairs (a later read may depend on the store)", () => {
		// The spill/reload idiom in raw library asm: the slot is read again
		// after the pair. Removing the pair would delete the only write to
		// the slot — unsound without stack-slot liveness (see the note in
		// optimize_asm.ts). Regression test for a pass that was tried and
		// reverted.
		const asm = [
			"_f:",
			"bl _malloc",
			"str x0, [sp, #72]",
			"ldr x0, [sp, #72]",
			"mov x1, x0",
			"ldr x0, [sp, #72]",
			"ret",
		].join("\n");
		const out = optimize_asm(asm);
		expect(out).toBe(asm);
	});

	test("folds constant comparisons and drops never-taken branches", () => {
		// The dispatch must end at a "safe follower" (here `ret`) for the
		// fold to apply — a plain instruction after the run could read the
		// stale flags, so fold_asm_constants leaves that shape alone.
		const asm = [
			"_f:",
			"mov x3, #8",
			"cmp x3, #1",
			"b.eq .Lbyte",
			"b.gt .Lwide",
			"ret",
			".Lbyte:",
			"mov x0, #1",
			"ret",
			".Lwide:",
			"mov x0, #2",
			"ret",
		].join("\n");
		const out = optimize_asm(asm);
		// x3 is a known 8: the cmp and b.eq vanish, b.gt becomes an
		// unconditional `b .Lwide`. The .Lbyte tail is unreachable from here
		// but remains (it may be a target from elsewhere in a real program —
		// this pipeline only removes straight-line dead code).
		expect(out).toBe(
			[
				"_f:",
				"mov x3, #8",
				"b .Lwide",
				".Lbyte:",
				"mov x0, #1",
				"ret",
				".Lwide:",
				"mov x0, #2",
				"ret",
			].join("\n"),
		);
	});

	test("leaves a constant dispatch alone when the follower could read flags", () => {
		const asm = [
			"_f:",
			"mov x3, #8",
			"cmp x3, #1",
			"b.eq .Lbyte",
			"mov x0, #7",
			"b.gt .Lwide",
			"ret",
			".Lbyte:",
			"ret",
			".Lwide:",
			"ret",
		].join("\n");
		const out = optimize_asm(asm);
		// The trailing `b.gt` is separated from the cmp by `mov x0, #7`, so
		// folding the cmp would leave the branch reading stale flags. The
		// conservative pass keeps the whole shape intact.
		expect(out).toBe(asm);
	});

	test("strength-reduces a multiply by a known power of two", () => {
		const asm = ["_f:", "mov x3, #8", "mul x0, x1, x3", "ret"].join("\n");
		const out = optimize_asm(asm);
		expect(out).toContain("lsl x0, x1, #3");
		expect(out).not.toContain("mul");
	});

	test("does not track constants across a call", () => {
		const asm = [
			"_f:",
			"mov x3, #8",
			"bl _malloc",
			"cmp x3, #1",
			"b.eq .Lbyte",
			"ret",
			".Lbyte:",
			"ret",
		].join("\n");
		const out = optimize_asm(asm);
		// x3 may be clobbered by the call — the cmp/branch must stay.
		expect(out).toContain("cmp x3, #1");
		expect(out).toContain("b.eq .Lbyte");
	});

	test("blank lines and comments inside the pipeline are tolerated", () => {
		const asm = ["_f:", "mov x0, #1", "", "// comment", "mov x0, x0", "ret"].join("\n");
		const out = optimize_asm(asm);
		// The identity move goes; surrounding blanks/comments stay put.
		expect(out).toBe(["_f:", "mov x0, #1", "", "// comment", "ret"].join("\n"));
	});
});

describe("release build integration", () => {
	test("optimized aarch64 build produces correct output", async () => {
		const input = `
var int total = 0
var int i = 0
while i < 10 {
	total = total + i * 2
	i = i + 1
}
Console.write(total.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", optimize: true });
		expect(result.errors ?? []).toEqual([]);
		// The optimized output must be no larger than the unoptimized one
		// (every pass only shrinks or preserves).
		const plain = build(parsed.root, { arch: "aarch64" });
		expect(result.code.length).toBeLessThanOrEqual(plain.code.length);
		await check_output("release_optimize_smoke", result, "90", { arch: "aarch64", audit: false });
	});
});
