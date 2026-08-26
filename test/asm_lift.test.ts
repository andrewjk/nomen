import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { validate_asm, lift_functions } from "../src/build_aarch64/lift_asm";
import parse_with_imports from "./parse_with_imports";

describe("asm lift validation", () => {
	test("clean function passes", () => {
		const asm = [
			"// header comment",
			".text",
			"_f:",
			"stp x29, x30, [sp, #-16]!",
			"mov x29, sp",
			"cmp x0, #10",
			"b.ge .Lbig",
			"add x0, x0, #1",
			"b .Ldone",
			".Lbig:",
			"sub x0, x0, #1",
			".Ldone:",
			"ldp x29, x30, [sp], #16",
			"ret",
		].join("\n");
		expect(validate_asm(asm)).toEqual([]);
	});

	test("unknown mnemonic fails", () => {
		const errors = validate_asm(["_f:", "frobnicate x0, x1", "ret"].join("\n"));
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("unknown mnemonic 'frobnicate'");
	});

	test("wrong operand shape fails (integer op on d-registers)", () => {
		// The float compound-assignment bug class: integer add over double bits.
		const errors = validate_asm(
			["_f:", "ldr x1, [x29, #40]", "adr x0, _lit", "ldr x0, [x0]", "add x0, x1, x0", "ret"].join(
				"\n",
			),
		);
		expect(errors).toEqual([]);
		const bad = validate_asm(
			["_f:", "fmov d0, x0", "fmov d1, x1", "fadd x0, d1, d0", "ret"].join("\n"),
		);
		expect(bad.length).toBe(1);
		expect(bad[0].message).toContain("'fadd' operand shape mismatch");
	});

	test("branch to undefined label fails", () => {
		const errors = validate_asm(["_f:", "cmp x0, #0", "b.eq .Lnowhere", "ret"].join("\n"));
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("undefined label '.Lnowhere'");
	});

	test("conditional branch with no flag setter fails", () => {
		const errors = validate_asm(["_f:", "ldr x0, [x29, #8]", "b.eq .Lx", ".Lx:", "ret"].join("\n"));
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("no preceding flag-setting instruction");
	});

	test("flags survive non-flag instructions within a block", () => {
		const asm = ["_f:", "cmp x0, #0", "ldr x9, [x29, #16]", "b.ne .Lx", ".Lx:", "ret"].join("\n");
		expect(validate_asm(asm)).toEqual([]);
	});

	test("balanced frame passes and resets at function boundary", () => {
		const asm = [
			"_a:",
			"stp x29, x30, [sp, #-16]!",
			"sub sp, sp, #32",
			"add sp, sp, #32",
			"ldp x29, x30, [sp], #16",
			"ret",
			"_b:",
			"stp x29, x30, [sp, #-16]!",
			"bl _a",
			"ldp x29, x30, [sp], #16",
			"ret",
		].join("\n");
		expect(validate_asm(asm)).toEqual([]);
	});

	test("post-index push/pop pairs parse", () => {
		const asm = [
			"_f:",
			"str x0, [sp, #-16]!",
			"str x1, [sp, #-16]!",
			"ldr x1, [sp], #16",
			"ldr x0, [sp], #16",
			"ret",
		].join("\n");
		expect(validate_asm(asm)).toEqual([]);
	});

	test("ARM32-style branch aliases in raw library blocks are accepted", () => {
		const asm = ["_f:", "cmp w0, #0", "blt .Lx", ".Lx:", "ret"].join("\n");
		expect(validate_asm(asm)).toEqual([]);
	});

	test("call clobbers flags — cond after bl without cmp fails", () => {
		const asm = ["_f:", "cmp x0, #0", "bl _g", "b.lt .Lx", ".Lx:", "ret", "_g:", "ret"].join("\n");
		const errors = validate_asm(asm);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("conditional 'b.lt'");
	});
});

describe("asm lift on real builds", () => {
	test("a representative program lifts clean, functions segmented", async () => {
		const input = `
var int total = 0
var int i = 0
while i < 5 {
	total += i * 3
	i += 1
}
Console.write(total.to_string())
Console.write("\\n")
var float f = 1.5
if f > 1.0 {
	Console.write("big\\n")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		const lift = lift_functions(result.code);
		expect(lift.result.errors).toEqual([]);
		expect(lift.result.functions.length).toBeGreaterThan(1);
		// Round-trip fidelity: re-emitting the lifted lines is byte-identical.
		const rejoined = lift.result.lines.map((l) => l.text).join("\n");
		expect(rejoined).toBe(result.code);
	});
});
