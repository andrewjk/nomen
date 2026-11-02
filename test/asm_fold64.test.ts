import { expect, test } from "vite-plus/test";

import build from "../src/build";
import {
	fold64_enabled,
	fold_64bit_arithmetic,
	set_fold64_enabled,
} from "../src/build_aarch64/asm_fold64";
import { validate_asm } from "../src/build_aarch64/lift_asm";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// PERF_PLAN item 15 — the 64-bit arithmetic folds (the FOLLOWUP.md trio):
// immediate shift counts, field-value forwarding, and constant
// materialization. The Random.next receipt is the reference shape: splitmix64
// is pure Nomen and the aarch64 emission paid ~40 instructions where a raw
// `#arch` body was ~14 — a register-materialized shift count per `>>`, a
// store-then-reload of `self.state`, and a movz + three-movk chain per 64-bit
// literal.

function fold(asm: string[]): string[] {
	const out = fold_64bit_arithmetic(asm.join("\n"));
	return out.split("\n");
}

function fold_validated(asm: string[]): string {
	// Every test transformation must still lift clean (the literal ldr form
	// is a contracted shape in asm_ir.ts).
	const out = fold_64bit_arithmetic(asm.join("\n"));
	expect(validate_asm(out)).toEqual([]);
	return out;
}

// --- Fold 1: immediate shift counts -----------------------------------------

test("register shift count folds to the immediate form (count reg == dest)", () => {
	const out = fold([
		"f:",
		"mov x12, x0",
		"mov x0, #30",
		"lsr x0, x12, x0",
		"eor x0, x12, x0",
		"ret",
	]);
	expect(out).toContain("lsr x0, x12, #30");
	expect(out).not.toContain("mov x0, #30");
	// the eor still reads the pre-shift value through x12
	expect(out).toContain("eor x0, x12, x0");
});

test("count reg != dest folds when the count reg is redefined before its next read", () => {
	const out = fold(["f:", "mov x9, #5", "lsl x1, x2, x9", "mov x9, x3", "add x1, x1, x9", "ret"]);
	expect(out).toContain("lsl x1, x2, #5");
	expect(out).not.toContain("mov x9, #5");
});

test("count reg read after the shift keeps the register form", () => {
	const out = fold(["f:", "mov x9, #5", "lsl x1, x2, x9", "add x3, x9, x4", "ret"]);
	expect(out).toContain("mov x9, #5");
	expect(out).toContain("lsl x1, x2, x9");
});

test("count reg feeding the DATA path never folds", () => {
	// xR == xS: the mov redefines the shifted source, so the register form
	// and the immediate form read different values.
	const out = fold(["f:", "mov x0, #30", "lsr x0, x0, x0", "ret"]);
	expect(out).toContain("mov x0, #30");
	expect(out).toContain("lsr x0, x0, x0");
});

test("out-of-range counts keep the register form", () => {
	const out = fold(["f:", "mov x0, #64", "lsr x0, x1, x0", "mov w3, #32", "lsl w3, w4, w3", "ret"]);
	expect(out).toContain("mov x0, #64");
	expect(out).toContain("lsr x0, x1, x0");
	expect(out).toContain("mov w3, #32");
	expect(out).toContain("lsl w3, w4, w3");
});

test("w-register shifts fold within the 5-bit range", () => {
	const out = fold(["f:", "mov w0, #4", "lsr w0, w2, w0", "ret"]);
	expect(out).toContain("lsr w0, w2, #4");
	expect(out).not.toContain("mov w0, #4");
});

test("a label between the count mov and the shift refuses", () => {
	const out = fold(["f:", "mov x0, #30", ".else_0:", "lsr x0, x12, x0", "ret"]);
	expect(out).toContain("mov x0, #30");
	expect(out).toContain("lsr x0, x12, x0");
});

// --- Fold 2: field-value forwarding -----------------------------------------

test("store + receiver re-derivation + reload forwards the stored register", () => {
	// the Random.next shape: self.state = ...; var z = self.state
	const out = fold_validated([
		"f:",
		"stp x29, x30, [sp, #-16]!",
		"str x0, [x19, #8]",
		"mov x0, x19",
		"ldr x0, [x0, #8]",
		"mov x12, x0",
		"ret",
	]);
	expect(out).toContain("str x0, [x19, #8]");
	// xD == xV: the whole re-derivation + reload disappears
	expect(out).not.toContain("mov x0, x19");
	expect(out).not.toContain("ldr x0, [x0, #8]");
	expect(out).toContain("mov x12, x0");
});

test("store + direct reload forwards when the destinations differ", () => {
	const out = fold(["f:", "str x1, [x19, #16]", "ldr x2, [x19, #16]", "add x0, x2, x1", "ret"]);
	expect(out).toContain("str x1, [x19, #16]");
	expect(out).toContain("mov x2, x1");
	expect(out).not.toContain("ldr x2, [x19, #16]");
});

test("a call between the store and the reload refuses", () => {
	const out = fold([
		"f:",
		"str x0, [x19, #8]",
		"bl mutate",
		"mov x0, x19",
		"ldr x0, [x0, #8]",
		"ret",
	]);
	expect(out).toContain("bl mutate");
	expect(out).toContain("ldr x0, [x0, #8]");
});

test("a different slot offset refuses", () => {
	const out = fold(["f:", "str x1, [x19, #16]", "ldr x2, [x19, #24]", "ret"]);
	expect(out).toContain("ldr x2, [x19, #24]");
});

test("a different base refuses", () => {
	const out = fold(["f:", "str x1, [x19, #16]", "ldr x2, [x20, #16]", "ret"]);
	expect(out).toContain("ldr x2, [x20, #16]");
});

test("a width mismatch refuses", () => {
	const out = fold(["f:", "str x0, [x19, #8]", "ldr w1, [x0, #8]", "ret"]);
	expect(out).toContain("ldr w1, [x0, #8]");
});

test("w-store forwards to a w-reload", () => {
	const out = fold(["f:", "str w0, [x19, #12]", "mov x9, x19", "ldr w1, [x9, #12]", "ret"]);
	expect(out).toContain("str w0, [x19, #12]");
	expect(out).toContain("mov w1, w0");
	expect(out).not.toContain("ldr w1, [x9, #12]");
});

// --- Fold 3: constant materialization ---------------------------------------

test("a full-width movz/movk chain becomes one literal-pool load", () => {
	const out = fold_validated([
		"f:",
		"ldr x1, [x0, #8]",
		"movz x2, #31765",
		"movk x2, #32586, lsl #16",
		"movk x2, #31161, lsl #32",
		"movk x2, #40503, lsl #48",
		"add x0, x1, x2",
		"ret",
	]);
	expect(out).toContain("ldr x2, .LC64_0");
	expect(out).not.toContain("movz");
	expect(out).not.toContain("movk");
	// the pool sits after the function's final ret, before whatever follows
	const lines = out.split("\n");
	const ret_idx = lines.findIndex((l) => l.trim() === "ret");
	expect(ret_idx).toBeGreaterThan(-1);
	expect(lines.slice(ret_idx + 1, ret_idx + 3)).toEqual([
		"\t.LC64_0:",
		"\t.quad -7046029254386353131", // 0x9E3779B97F4A7C15 signed
	]);
});

test("a movn-headed chain pools its inverted pattern", () => {
	const out = fold_validated([
		"f:",
		"movn x2, #1",
		"movk x2, #4660, lsl #16",
		"movk x2, #4660, lsl #32",
		"ret",
	]);
	expect(out).toContain("ldr x2, .LC64_0");
	// movn sets every bit above the inverted 16-bit field, so the pattern is
	// 0xFFFFFFFF_1234_FFFE (chunks 1 and 2 replaced by the movk links)
	expect(out).toContain(".quad -261460123648002");
});

test("a one-link chain keeps the movz/movk form", () => {
	const out = fold(["f:", "movz x2, #4660", "movk x2, #1, lsl #16", "add x0, x0, x2", "ret"]);
	expect(out).toContain("movz x2, #4660");
	expect(out).toContain("movk x2, #1, lsl #16");
});

test("identical constants in one function share a pool entry", () => {
	const out = fold_validated([
		"f:",
		"movz x2, #31765",
		"movk x2, #32586, lsl #16",
		"movk x2, #31161, lsl #32",
		"movk x2, #40503, lsl #48",
		"add x0, x0, x2",
		"movz x3, #31765",
		"movk x3, #32586, lsl #16",
		"movk x3, #31161, lsl #32",
		"movk x3, #40503, lsl #48",
		"add x0, x0, x3",
		"ret",
	]);
	expect(out).toContain("ldr x2, .LC64_0");
	expect(out).toContain("ldr x3, .LC64_0");
	expect(out.split(".quad").length - 1).toBe(1);
});

test("a function with no reachable ret keeps its chains", () => {
	const asm = [
		"f:",
		"movz x2, #31765",
		"movk x2, #32586, lsl #16",
		"movk x2, #31161, lsl #32",
		"movk x2, #40503, lsl #48",
		"add x0, x0, x2",
		"br x5",
	];
	const out = fold_64bit_arithmetic(asm.join("\n"));
	expect(out).toBe(asm.join("\n"));
});

// --- Kill switch ------------------------------------------------------------

test("the kill switch returns the text unchanged", () => {
	const asm = [
		"f:",
		"mov x0, #30",
		"lsr x0, x12, x0",
		"movz x2, #31765",
		"movk x2, #32586, lsl #16",
		"movk x2, #31161, lsl #32",
		"movk x2, #40503, lsl #48",
		"ret",
	].join("\n");
	const was = fold64_enabled();
	set_fold64_enabled(false);
	try {
		expect(fold_64bit_arithmetic(asm)).toBe(asm);
		set_fold64_enabled(true);
		expect(fold_64bit_arithmetic(asm)).not.toBe(asm);
	} finally {
		set_fold64_enabled(was);
	}
});

// --- The Random.next receipt, end to end ------------------------------------

function build_aarch64(source: string): string {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", audit: false });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const SPLITMIX_PROGRAM = `
mv struct R {
	var uint64 state = 0

	func #init = (self, uint64 seed) {
		self.state = seed
	}

	func next = (ref self, out uint64) {
		self.state = self.state + 0x9E3779B97F4A7C15
		var uint64 z = self.state
		z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
		z = (z ^ (z >> 27)) * 0x94D049BB133111EB
		return z ^ (z >> 31)
	}
}

var R r = R(42)
Console.write("\\{r.next()}\\n")
Console.write("\\{r.next()}\\n")
`;

test("the splitmix body carries all three folds", () => {
	const code = build_aarch64(SPLITMIX_PROGRAM);
	const start = code.indexOf("R_next:");
	const end = code.indexOf(".return_R_next:", start);
	const body = code.slice(start, end);
	// immediate shift counts
	expect(body).toContain("lsr x0, x12, #30");
	expect(body).toContain("lsr x0, x12, #27");
	expect(body).toContain("lsr x0, x12, #31");
	expect(body).not.toContain("movz");
	expect(body).not.toContain("movk");
	// constant materialization — one pooled load per literal
	expect(body).toContain("ldr x2, .LC64_0");
	expect(body).toContain("ldr x2, .LC64_1");
	expect(body).toContain("ldr x2, .LC64_2");
	// field-value forwarding — the store is not followed by a reload
	expect(body).toContain("str x0, [x19, #8]");
	expect(body).not.toContain("ldr x0, [x0, #8]");
	// the pool sits after the epilogue's ret
	const pool = code.slice(code.indexOf("\t.LC64_0:"));
	expect(pool).toContain(".quad -7046029254386353131");
	expect(pool).toContain(".quad -4658895280553007687");
	expect(pool).toContain(".quad -7723592293110705685");
	// instruction count: the receipt. Body lines before the folds: 43.
	const instrs = body
		.split("\n")
		.filter((l) => l.trim() && !l.trim().endsWith(":") && !l.trim().startsWith("."));
	expect(instrs.length).toBeLessThanOrEqual(28);
});

test("behavioral: the splitmix64 sequence is unchanged (both backends)", async () => {
	await build_and_check_output(
		SPLITMIX_PROGRAM,
		"fold64_splitmix",
		"13679457532755275413\n2949826092126892291\n",
	);
});
