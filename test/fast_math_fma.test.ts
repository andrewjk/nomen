import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";

/**
 * NEON/fast-math tranche 6: FMA contraction — the `-ffp-contract=fast`
 * analog. Under `--fast-math`, `a*b ± c` fuses into the single-rounding
 * fmadd family in scalar code and fmla/fmls in vector lane bodies. Without
 * the flag, every float expression keeps its separate mul and add.
 */

function compile(source: string, fast_math: boolean): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", fast_math });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const FORMS = `
import System

func add_right = (float a, float b, float c, out float) {
	return c + a * b
}
func sub_left = (float a, float b, float c, out float) {
	return a * b - c
}
func sub_right = (float a, float b, float c, out float) {
	return c - a * b
}
pub func main = () {}
`;

test("fast_math off keeps separate mul and add", () => {
	const code = compile(FORMS, false);
	expect(code).not.toContain("fmadd");
	expect(code).not.toContain("fmsub");
	expect(code).not.toContain("fnmadd");
	expect(code).toContain("fmul d0, d0, d1");
});

test("fast_math contracts a*b + c into fmadd", () => {
	const code = compile(
		`
import System

func f = (float a, float b, float c, out float) {
	return a * b + c
}
pub func main = () {}
`,
		true,
	);
	expect(code).toContain("fmadd d0, d0, d1, d2");
});

test("fast_math contracts the subtract family (fmsub, fnmadd)", () => {
	const code = compile(FORMS, true);
	// a*b - c → fmsub; c - a*b → fnmadd; c + a*b → fmadd
	expect(code).toContain("fmsub d0, d0, d1, d2");
	expect(code).toContain("fnmadd d0, d0, d1, d2");
	expect(code).toContain("fmadd d0, d0, d1, d2");
});

test("mandelbrot-shape x*x - y*y + c contracts the sub to fmsub", () => {
	// (zr*zr - zi*zi) + cr: the top add's left is a SUB, so the top level
	// stays fadd; the sub (mul - mul, left preferred) fuses to fmsub —
	// one-level contraction, clang-style.
	const code = compile(
		`
import System

func mandel_step = (float zr, float zi, float cr, out float) {
	return zr * zr - zi * zi + cr
}
pub func main = () {}
`,
		true,
	);
	expect(code).toContain("fmsub d0, d0, d1, d2");
	expect(code).toContain("fadd d0, d0, d1");
});

test("fast_math contracts vector lane bodies into fmla", () => {
	const code = compile(
		`
import System

func scale_into = (ref Buffer<float> a, ref Buffer<float> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			b.store_float(i, a.load_float(i) * 2.0 + 1.0)
		}
	}
}
pub func main = () {}
`,
		true,
	);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("fmla v8.2d, v0.2d, v1.2d");
});

test("vector fmla contraction stays off without fast_math", () => {
	const code = compile(
		`
import System

func scale_into = (ref Buffer<float> a, ref Buffer<float> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			b.store_float(i, a.load_float(i) * 2.0 + 1.0)
		}
	}
}
pub func main = () {}
`,
		false,
	);
	expect(code).toContain(".Lneon_0:");
	expect(code).not.toContain("fmla");
});

test("behavioral: FMA-contracted code prints exact dyadic results", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func fma_form = (float a, float b, float c, out float) {
	return a * b + c
}

func scale_into = (ref Buffer<float> a, ref Buffer<float> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			const float x = a.load_float(i) * 2.0
			b.store_float(i, x + 1.0)
		}
	}
}
pub func main = () {
	Console.write("\\{fma_form(0.5, 0.25, 1.5)} \\{fma_form(2.0, 3.0, 4.0)}")
	var a = Buffer<float>()
	var b = Buffer<float>()
	a.alloc_float(9)
	b.alloc_float(9)
	if a.cap >= 9 && b.cap >= 9 {
		var i = 0
		while i < 9 {
			a.store_float(i, i as float * 0.5)
			i += 1
		}
		scale_into(ref a, ref b, 9)
		i = 0
		while i < 9 {
			Console.write(" \\{b.load_float(i)}")
			i += 1
		}
	}
}
`,
		"fast_math_fma",
		"1.625000 10.000000 1.000000 2.000000 3.000000 4.000000 5.000000 6.000000 7.000000 8.000000 9.000000",
		true,
		{ fast_math: true },
	);
});
