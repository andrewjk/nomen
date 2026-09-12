import { expect, test } from "vite-plus/test";

import build from "../src/build";
import {
	elide_stack_staging,
	set_staging_elide_enabled,
	staging_elide_enabled,
} from "../src/build_aarch64/asm_staging_elide";
import { validate_asm } from "../src/build_aarch64/lift_asm";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

/**
 * Stack-staging elision (ASM_PLAN_7 tranche 5). The spectral-norm
 * receipt: around every computed index the emitter staged the value
 * through a stack round-trip (`mov x1, x25` + `str x1, [sp, #-16]!` …
 * `ldr x1, [sp], #16` + read) even though it sat in a register — three
 * instructions of pure staging per index, ×2 paths. Two elision forms:
 * the mov-form (triple delete + consumer rename, verdict-gated on exact
 * liveness of the staging register) and the bare-pair form (a semantic
 * identity around a clean middle, deleted unconditionally).
 */

function elide(lines: string[]): string[] {
	const out = elide_stack_staging(lines.join("\n"));
	expect(validate_asm(out)).toEqual([]);
	return out.split("\n").filter((l) => l.trim() !== "");
}

test("the mov-form receipt elides to a direct register read", () => {
	const out = elide([
		"f:",
		".while_0:",
		"cmp x24, x26",
		"b.ge .end_while_0",
		"mov x1, x25",
		"str x1, [sp, #-16]!",
		"add x0, x13, x24",
		"ldr x1, [sp], #16",
		"add x0, x1, x0",
		"mov x25, x0",
		".while_update_0:",
		"add x24, x24, #1",
		"b .while_0",
		".end_while_0:",
		"ret",
	]);
	const text = out.join("\n");
	expect(text).not.toContain("str x1, [sp, #-16]!");
	expect(text).not.toContain("ldr x1, [sp], #16");
	expect(text).not.toContain("mov x1, x25");
	// The consumer reads the register-resident source directly.
	expect(text).toContain("add x0, x25, x0");
	// The index computation is untouched.
	expect(text).toContain("add x0, x13, x24");
});

test("a bare pair around a clean middle is a pure identity deletion", () => {
	// The value comes from a SLOT load (no staging mov) — the pair still
	// elides; the register keeps its value across the untouched middle.
	const out = elide([
		"f:",
		"add x1, x29, #32",
		"ldr x1, [x29, #32]",
		"str x1, [sp, #-16]!",
		"add x0, x16, x23",
		"ldr x1, [sp], #16",
		"add x0, x1, x0",
		"str x0, [x29, #32]",
		"ret",
	]);
	const text = out.join("\n");
	expect(text).not.toContain("[sp, #-16]!");
	expect(text).not.toContain("[sp], #16");
	expect(text).toContain("ldr x1, [x29, #32]");
	expect(text).toContain("add x0, x1, x0");
});

test("a pair whose middle touches the register stays", () => {
	const asm = [
		"f:",
		"str x1, [sp, #-16]!",
		"mov x1, x5",
		"ldr x1, [sp], #16",
		"add x0, x1, x0",
		"ret",
	].join("\n");
	expect(elide_stack_staging(asm)).toBe(asm);
});

test("a pair whose middle contains a call stays", () => {
	const asm = ["f:", "str x0, [sp, #-16]!", "bl _free", "ldr x0, [sp], #16", "ret"].join("\n");
	expect(elide_stack_staging(asm)).toBe(asm);
});

test("a pair whose middle spans a label stays", () => {
	const asm = [
		"f:",
		"str x1, [sp, #-16]!",
		"cbz x5, skip",
		"ldr x1, [sp], #16",
		"skip:",
		"ret",
	].join("\n");
	expect(elide_stack_staging(asm)).toBe(asm);
});

test("a w-sibling redefinition of the source register refuses the rename", () => {
	// `ldrb w0` rewrites x0's low half after the staging mov — the staged
	// value differs from the live x0 at the consumer, and the naive rename
	// would compare a register with itself (the regex character-class
	// receipt).
	const out = elide([
		"f:",
		"and x0, x25, #0xFF",
		"mov x1, x0",
		"str x1, [sp, #-16]!",
		"ldrb w0, [x29, #208]",
		"mov x2, x0",
		"ldr x1, [sp], #16",
		"cmp x1, x0",
		"b.lt end_0",
		"end_0:",
		"ret",
	]);
	const text = out.join("\n");
	// The pair may still elide (bare identity), but the cmp must NOT
	// become `cmp x0, x0`.
	expect(text).not.toContain("cmp x0, x0");
	expect(text).toContain("cmp x1, x0");
});

test("a staging register still read after the consumer refuses the rename", () => {
	const asm = [
		"f:",
		"mov x1, x25",
		"str x1, [sp, #-16]!",
		"add x0, x13, x24",
		"ldr x1, [sp], #16",
		"add x0, x1, x0",
		"str x1, [x29, #8]",
		"ret",
	].join("\n");
	const out = elide_stack_staging(asm);
	// The pair itself is an identity and may elide, but x1's post-consumer
	// value is observable — the consumer must keep reading x1, never the
	// renamed x25.
	expect(out).toContain("add x0, x1, x0");
	expect(out).not.toContain("add x0, x25, x0");
	expect(out).toContain("str x1, [x29, #8]");
});

test("a redefinition of the source register in the middle refuses the rename", () => {
	const asm = [
		"f:",
		"mov x1, x0",
		"str x1, [sp, #-16]!",
		"mov x0, #1",
		"add x0, x23, x0",
		"ldr x1, [sp], #16",
		"mul x0, x1, x0",
		"ret",
	].join("\n");
	const out = elide_stack_staging(asm);
	// x0 is recomputed between the staging and the consumer — the staged
	// (old) value differs from the live x0, so the consumer must keep
	// reading the staging register.
	expect(out).toContain("mul x0, x1, x0");
	expect(out).not.toContain("mul x0, x0, x0");
});

test("kill-switch restores the text byte-identically", () => {
	const asm = [
		"f:",
		"mov x1, x25",
		"str x1, [sp, #-16]!",
		"add x0, x13, x24",
		"ldr x1, [sp], #16",
		"add x0, x1, x0",
		"ret",
	].join("\n");
	const saved = staging_elide_enabled();
	set_staging_elide_enabled(false);
	try {
		expect(elide_stack_staging(asm)).toBe(asm);
	} finally {
		set_staging_elide_enabled(saved);
	}
});

test("real-build staging pairs elide while prologue spills survive", () => {
	const src = `
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
`;
	const compile = (): string => {
		const parsed = parse_raw(src);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		return result.code;
	};
	const on = compile();
	set_staging_elide_enabled(false);
	const off = compile();
	set_staging_elide_enabled(true);
	// Both arm pairs are gone; prologue/callee-saved spills (here and in
	// the library) stay.
	const pushes = (code: string): number => (code.match(/\[sp, #-16\]!/g) ?? []).length;
	expect(pushes(on)).toBeLessThan(pushes(off));
	// Scope to pick's own function: its staged pairs are gone.
	const fn_slice = (code: string): string => {
		const m = /\n(?:pick|_pick):/.exec(code);
		if (!m) return "";
		const end = code.indexOf(".p2align", m.index);
		return code.slice(m.index, end > m.index ? end : undefined);
	};
	expect(fn_slice(on)).not.toContain("str x1, [sp, #-16]!");
	expect(fn_slice(off)).toContain("str x1, [sp, #-16]!");
	expect(on).not.toBe(off);
});

test("behavioral: elided staging in a computed-index loop (both backends)", async () => {
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
		"staging_elide",
		"33 303 ",
		true,
	);
});
