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

	test("receiver address-of stages in the destination", () => {
		const out = rewrite_large_frame_offsets(["_f:", "add x0, x19, #6056", "ret"].join("\n"));
		expect(out).toBe(["_f:", "mov x0, #6056", "add x0, x19, x0", "ret"].join("\n"));
	});

	test("receiver address-of into its own base stages through x17", () => {
		const out = rewrite_large_frame_offsets(["_f:", "add x0, x0, #7160", "ret"].join("\n"));
		expect(out).toBe(["_f:", "mov x17, #7160", "add x0, x0, x17", "ret"].join("\n"));
	});

	test("receiver stores and sub-word accesses take the x17 path", () => {
		const out = rewrite_large_frame_offsets(
			["_f:", "stur x2, [x19, #7160]", "strb w1, [x19, #7168]", "ret"].join("\n"),
		);
		expect(out).toBe(
			[
				"_f:",
				"mov x17, #7160",
				"str x2, [x19, x17]",
				"mov x17, #7168",
				"strb w1, [x19, x17]",
				"ret",
			].join("\n"),
		);
	});

	test("receiver loads stage in the destination when distinct from the base", () => {
		const out = rewrite_large_frame_offsets(["_f:", "ldrb w1, [x19, #7168]", "ret"].join("\n"));
		// w-registers cannot stage (no movz on w): the x17 path.
		expect(out).toBe(["_f:", "mov x17, #7168", "ldrb w1, [x19, x17]", "ret"].join("\n"));
		const out2 = rewrite_large_frame_offsets(["_f:", "ldr x0, [x20, #40000]", "ret"].join("\n"));
		expect(out2).toBe(["_f:", "mov x0, #40000", "ldr x0, [x20, x0]", "ret"].join("\n"));
	});

	test("receiver loads into their own base keep the base intact", () => {
		const out = rewrite_large_frame_offsets(["_f:", "ldr x19, [x19, #40000]", "ret"].join("\n"));
		expect(out).toBe(["_f:", "mov x17, #40000", "ldr x19, [x19, x17]", "ret"].join("\n"));
	});

	test("receiver pairs compute the base into x17", () => {
		const out = rewrite_large_frame_offsets(["_f:", "ldp x0, x1, [x0, #8192]", "ret"].join("\n"));
		expect(out).toBe(
			["_f:", "mov x17, #8192", "add x17, x0, x17", "ldp x0, x1, [x17]", "ret"].join("\n"),
		);
	});

	test("receiver pairs at the ldp simm7 ceiling pass through", () => {
		const asm = ["_f:", "ldp x0, x1, [x19, #504]", "stp x2, x3, [x20, #504]", "ret"].join("\n");
		expect(rewrite_large_frame_offsets(asm)).toBe(asm);
	});

	test("receiver accesses within each scaled range pass through untouched", () => {
		const asm = [
			"_f:",
			"str x3, [x19, #4104]", // 64-bit scaled reach: 32760
			"str w3, [x19, #4104]", // 32-bit scaled reach: 16380
			"strh w3, [x19, #4104]", // 16-bit scaled reach: 8190
			"ldr x0, [x19, #4095]", // add/byte ceiling
			"ldur x0, [x19, #255]", // unscaled simm9 ceiling
			"add x0, x19, #4095",
			"ret",
		].join("\n");
		expect(rewrite_large_frame_offsets(asm)).toBe(asm);
	});

	test("unscaled stur rewrites just past simm9 where scaled forms would not", () => {
		const out = rewrite_large_frame_offsets(["_f:", "stur q0, [x19, #300]", "ret"].join("\n"));
		expect(out).toBe(["_f:", "mov x17, #300", "str q0, [x19, x17]", "ret"].join("\n"));
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

describe("receiver-relative field accesses (aarch64)", () => {
	// A struct whose body crosses the aarch64 immediate encodings: fields
	// past ~4-7 KB break `add imm12`, sub-word scaled forms, stur simm9, and
	// ldp/stp simm7 — the receiver-relative shims (asm_large_frame.ts) are
	// the only thing between this program and a rejected `.s`. Covers the
	// access kinds the shim rewrites: the ctor's zero stores (sub-word +
	// stur string pair), a far-field write/read, and the far-field
	// address-of (ref param).
	test("a struct with fields past every immediate range reads and writes them", async () => {
		const fields = Array.from({ length: 100 }, (_, i) => `\tvar Super s${i} = Super()`).join("\n");
		const input = `
import System

struct Chunk {
	var uint64 a = 0
	var uint64 b = 0
	var uint64 c = 0
	var uint64 d = 0
}

struct Super {
	var Chunk x = Chunk()
	var Chunk y = Chunk()
}

mv struct Big {
${fields}
	var bool done = false
	var string label
}

func flip = (ref bool v) {
	v = true
}

pub func main = (Init init) {
	var Big b = Big("ok")
	b.s99.y.b = 42
	flip(ref b.done)
	Console.write_line(b.s99.y.b.to_string())
	if b.done {
		Console.write_line("done")
	}
	Console.write_line(b.label)
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const options = { arch: "aarch64", audit: true } as const;
		const result = build(parsed.root, options);
		await check_output("large_receiver_fields", result, "42\ndone\nok\n", options);
	});
});
