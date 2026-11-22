import { expect, test } from "vite-plus/test";

import {
	convert_float_selects,
	eliminate_duplicate_fpr_loads,
	set_dup_load_cse_enabled,
	set_float_select_enabled,
} from "../src/build_aarch64/asm_load_cse";

/**
 * Duplicate-FPR-load elimination + single-arm float conditional-select
 * conversion (the mandelbrot escape check's scalar min-reduction —
 * `s = x*x + y*y; if s < acc { acc = s }` — emitted four loads for two and
 * a branchy fcmp+branch+fmov select). These tests pin the soundness edges:
 * invalidation by stores/labels/register defs/calls, the single-reference
 * label requirement, and the exact NaN-faithful condition inversion.
 */

function with_passes(run: () => void): void {
	set_dup_load_cse_enabled(true);
	set_float_select_enabled(true);
	try {
		run();
	} finally {
		set_dup_load_cse_enabled(false);
		set_float_select_enabled(false);
	}
}

test("same-destination duplicate load is deleted", () => {
	with_passes(() => {
		const code = [
			"ldr d0, [x7, x23, lsl #3]",
			"fmov d17, d0",
			"ldr d0, [x7, x23, lsl #3]",
			"fmov d18, d0",
			"fmul d16, d17, d18",
		].join("\n");
		const want = [
			"ldr d0, [x7, x23, lsl #3]",
			"fmov d17, d0",
			"fmov d18, d0",
			"fmul d16, d17, d18",
		].join("\n");
		expect(eliminate_duplicate_fpr_loads(code)).toBe(want);
	});
});

test("different-destination duplicate load becomes a register move", () => {
	with_passes(() => {
		const code = "ldr d6, [x9, #16]\nldr d7, [x9, #16]\nfmul d8, d6, d7";
		expect(eliminate_duplicate_fpr_loads(code)).toBe(
			"ldr d6, [x9, #16]\nfmov d7, d6\nfmul d8, d6, d7",
		);
	});
});

test("a store between the loads invalidates the record", () => {
	with_passes(() => {
		const code = [
			"ldr d0, [x7, x23, lsl #3]",
			"str d5, [x8, x23, lsl #3]",
			"ldr d0, [x7, x23, lsl #3]",
		].join("\n");
		expect(eliminate_duplicate_fpr_loads(code)).toBe(code);
	});
});

test("frame-slot stores keep heap-load records alive", () => {
	with_passes(() => {
		const code = [
			"ldr d0, [x7, x23, lsl #3]",
			"str x2, [x29, #24]",
			"ldr d0, [x7, x23, lsl #3]",
		].join("\n");
		// The frame store cannot alias the heap address, so the record
		// survives and the duplicate load is still deleted.
		const want = ["ldr d0, [x7, x23, lsl #3]", "str x2, [x29, #24]"].join("\n");
		expect(eliminate_duplicate_fpr_loads(code)).toBe(want);
	});
});

test("redefining the address register invalidates the record", () => {
	with_passes(() => {
		const code = [
			"ldr d0, [x7, x23, lsl #3]",
			"add x23, x23, #1",
			"ldr d0, [x7, x23, lsl #3]",
		].join("\n");
		expect(eliminate_duplicate_fpr_loads(code)).toBe(code);
	});
});

test("redefining the holding register invalidates the record", () => {
	with_passes(() => {
		const code = ["ldr d0, [x7, x23, lsl #3]", "fmov d0, d9", "ldr d0, [x7, x23, lsl #3]"].join(
			"\n",
		);
		expect(eliminate_duplicate_fpr_loads(code)).toBe(code);
	});
});

test("a call clears every record", () => {
	with_passes(() => {
		const code = ["ldr d0, [x7, x23, lsl #3]", "bl _malloc", "ldr d0, [x7, x23, lsl #3]"].join(
			"\n",
		);
		expect(eliminate_duplicate_fpr_loads(code)).toBe(code);
	});
});

test("a label clears the records (join-point provenance)", () => {
	with_passes(() => {
		const code = ["ldr d0, [x7, x23, lsl #3]", ".end_5:", "ldr d0, [x7, x23, lsl #3]"].join("\n");
		expect(eliminate_duplicate_fpr_loads(code)).toBe(code);
	});
});

test("single-arm float select becomes fcsel", () => {
	with_passes(() => {
		const code = [
			"fmov d1, d8",
			"fmov d0, d10",
			"fcmp d0, d1",
			"b.pl end_53",
			"fmov d8, d10",
			"end_53:",
			"adrp x3, _float_op_9@PAGE",
		].join("\n");
		const want = [
			"fmov d1, d8",
			"fmov d0, d10",
			"fcmp d0, d1",
			"fcsel d8, d10, d8, mi",
			"adrp x3, _float_op_9@PAGE",
		].join("\n");
		expect(convert_float_selects(code)).toBe(want);
	});
});

test("the fcsel condition inverts per skip-branch code", () => {
	with_passes(() => {
		const code = "fcmp d0, d1\nb.mi end_1\nfmov d9, d11\nend_1:\nret";
		expect(convert_float_selects(code)).toBe("fcmp d0, d1\nfcsel d9, d11, d9, pl\nret");
	});
});

test("a multi-reference target label is left alone", () => {
	with_passes(() => {
		const code = [
			"cmp x0, x1",
			"b.eq end_2",
			"fcmp d0, d1",
			"b.pl end_2",
			"fmov d8, d10",
			"end_2:",
			"ret",
		].join("\n");
		expect(convert_float_selects(code)).toBe(code);
	});
});

test("a two-arm diamond (assignment not adjacent to the label) is left alone", () => {
	with_passes(() => {
		const code = [
			"fcmp d0, d1",
			"b.pl end_3",
			"fmov d8, d10",
			"b after_3",
			"end_3:",
			"fmov d8, d1",
			"after_3:",
			"ret",
		].join("\n");
		expect(convert_float_selects(code)).toBe(code);
	});
});

test("an instruction between fcmp and the branch blocks the rewrite", () => {
	with_passes(() => {
		const code = ["fcmp d0, d1", "fmov d2, d3", "b.pl end_4", "fmov d8, d10", "end_4:", "ret"].join(
			"\n",
		);
		expect(convert_float_selects(code)).toBe(code);
	});
});
