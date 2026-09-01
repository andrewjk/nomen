import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";

/**
 * Param-type-aware loop promotion: a loop candidate with NO scoped
 * declaration and NO body-declare record (i.e. a parameter) used to resolve
 * to `type_name: ""` — the ""→int default legitimately promoted int params
 * (`while i < n`) but also claimed X-REGISTERS for FLOAT params
 * (mandelbrot's `mbrot` claimed x25/x26 for cr/ci through the int branch).
 * The prologue now records param types (`status.function_param_types`) and
 * promote_loop_locals routes known floats to the float pool; a known
 * non-scalar param is skipped entirely.
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const FLOAT_PARAM_SHAPE = `
import System

func mbrot = (float cr, float ci, out int) {
	var zr = 0.0
	var zi = 0.0
	var i = 0
	while i < 5; i += 1 {
		zi = (zr + zr) * zi + ci
		zr = zr * zr + cr
	}
	if zr * zr + zi * zi > 4.0 {
		return 0
	}
	return 1
}
pub func main = () {
	var inside = 0
	var k = 0
	while k < 4; k += 1 {
		inside = inside + mbrot(k as float * 0.5, k as float * 0.5)
	}
	Console.write("\\{inside}\\n")
}
`;

test("float params promote into the float pool, not the int pool", () => {
	const code = compile(FLOAT_PARAM_SHAPE);
	const fn = code.slice(code.indexOf("\nmbrot:"), code.indexOf("\n_main:"));
	// cr (slot #0) and ci (slot #8) must be claimed by the FLOAT pool: their
	// loop-entry cache fills are FP loads into claimed d-registers.
	expect(fn).toMatch(/ldr d\d+, \[x29, #0\]/);
	expect(fn).toMatch(/ldr d\d+, \[x29, #8\]/);
	// …and no int-pool claim of the float param slots (the bug's signature:
	// `ldr x25/x26, [x29, #0/#8]` entry loads through the ""→int default).
	expect(fn).not.toMatch(/ldr x\d+, \[x29, #0\]/);
	expect(fn).not.toMatch(/ldr x\d+, \[x29, #8\]/);
});

test("behavioral: float params riding promoted d-registers keep exact results", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(FLOAT_PARAM_SHAPE, "param_float_promotion", "1\n", true);
});
