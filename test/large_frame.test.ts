import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { rewrite_large_frame_offsets } from "../src/build_aarch64/asm_large_frame";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

describe("rewrite_large_frame_offsets", () => {
	test("chains sub sp into imm12-sized steps", () => {
		const out = rewrite_large_frame_offsets(["_f:", "sub sp, sp, #16448", "ret"].join("\n"));
		expect(out).toBe(
			[
				"_f:",
				"sub sp, sp, #4095",
				"sub sp, sp, #4095",
				"sub sp, sp, #4095",
				"sub sp, sp, #4095",
				"sub sp, sp, #68",
				"ret",
			].join("\n"),
		);
	});

	test("chains add sp in the epilogue", () => {
		const out = rewrite_large_frame_offsets(["_f:", "add sp, sp, #8200", "ret"].join("\n"));
		expect(out).toBe(
			["_f:", "add sp, sp, #4095", "add sp, sp, #4095", "add sp, sp, #10", "ret"].join("\n"),
		);
	});

	test("leaves in-range sp adjustments alone", () => {
		const asm = ["_f:", "sub sp, sp, #4095", "add sp, sp, #80", "ret"].join("\n");
		expect(rewrite_large_frame_offsets(asm)).toBe(asm);
	});

	test("add xN, x29, #big stages its own address", () => {
		const out = rewrite_large_frame_offsets(["_f:", "add x0, x29, #16392", "ret"].join("\n"));
		expect(out).toBe(["_f:", "mov x0, #16392", "add x0, x29, x0", "ret"].join("\n"));
	});

	test("ldr xN, [x29, #big] stages its own address", () => {
		const out = rewrite_large_frame_offsets(["_f:", "ldr x9, [x29, #16392]", "ret"].join("\n"));
		expect(out).toBe(["_f:", "mov x9, #16392", "ldr x9, [x29, x9]", "ret"].join("\n"));
	});

	test("stores and sub-word loads take the x17 scratch path", () => {
		const out = rewrite_large_frame_offsets(
			["_f:", "str x0, [x29, #8192]", "ldrb w9, [x29, #8193]", "ret"].join("\n"),
		);
		expect(out).toBe(
			[
				"_f:",
				"mov x17, #8192",
				"str x0, [x29, x17]",
				"mov x17, #8193",
				"ldrb w9, [x29, x17]",
				"ret",
			].join("\n"),
		);
	});

	test("pair forms compute the base into x17 (no register-offset ldp)", () => {
		const out = rewrite_large_frame_offsets(["_f:", "ldp x0, x1, [x29, #8192]", "ret"].join("\n"));
		expect(out).toBe(
			["_f:", "mov x17, #8192", "add x17, x29, x17", "ldp x0, x1, [x17]", "ret"].join("\n"),
		);
	});

	test("float loads take the scratch path", () => {
		const out = rewrite_large_frame_offsets(["_f:", "ldr d0, [x29, #5000]", "ret"].join("\n"));
		expect(out).toBe(["_f:", "mov x17, #5000", "ldr d0, [x29, x17]", "ret"].join("\n"));
	});

	test("trailing comments ride the shim", () => {
		const out = rewrite_large_frame_offsets(
			["_f:", "ldr x0, [x29, #8192] // self->mu", "ret"].join("\n"),
		);
		expect(out).toBe(["_f:", "mov x0, #8192", "ldr x0, [x29, x0] // self->mu", "ret"].join("\n"));
	});

	test("constants beyond the movz range expand through movk", () => {
		const out = rewrite_large_frame_offsets(["_f:", "ldr x0, [x29, #70000]", "ret"].join("\n"));
		expect(out).toBe(
			["_f:", "movz x0, #4464", "movk x0, #1, lsl #16", "ldr x0, [x29, x0]", "ret"].join("\n"),
		);
	});

	test("in-range accesses pass through untouched", () => {
		const asm = ["_f:", "ldr x0, [x29, #4095]", "str x1, [x29, #8]", "ret"].join("\n");
		expect(rewrite_large_frame_offsets(asm)).toBe(asm);
	});
});

describe("large frames (aarch64)", () => {
	// A 16 KB local array pushes the later frame offsets past the imm12
	// encodings — the function only assembles with the large-frame shims
	// (asm_large_frame.ts). Cover the access kinds the shim rewrites:
	// address-of (ref param), 64-bit load/store, and a call.
	test("a local past frame offset 4095 can be addressed, read, and written", async () => {
		const input = `
import System

func bump = (ref uint64 y) {
	y = 7
}

pub func main = () {
	var uint64[2048] big
	var uint64 x = 1
	bump(ref x)
	Console.write_line(x.to_string())
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const options = { arch: "aarch64", audit: true } as const;
		const result = build(parsed.root, options);
		await check_output("large_frame_basic", result, "7\n", options);
	});
});
