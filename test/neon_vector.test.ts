import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_neon_vectorization_enabled } from "../src/build_aarch64/neon_emit";
import { parse_raw } from "./parse_with_imports";

/**
 * Phase 4 NEON auto-vectorization tranche 1 (ASM_PLAN): elementwise float
 * loops (`while i < n` count-ups whose body is straight-line load_float /
 * store_float traffic at index i) lower to a 2-lane .2d vector loop that
 * runs before the unchanged scalar loop (the tail). Every test compiles for
 * aarch64; soundness rejections must leave the output scalar-only, and the
 * behavioral runs must print exact results on both backends. (Loop-bearing
 * functions carry the `n <= b.cap` guard the checker requires to verify the
 * load/store bounds constraints — the same shape spectral-norm.nm uses.)
 */

function compile_aarch64(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

function compiles_without_vector(source: string): string {
	const code = compile_aarch64(source);
	expect(code).not.toContain(".Lneon_");
	return code;
}

/** For shapes the checker itself rejects (unprovable bounds), the vectorizer
 *  must still never fire: compile leniently and assert no vector loop. */
function compiles_lenient_without_vector(source: string): void {
	const parsed = parse_raw(source);
	const result = build(parsed.root, { arch: "aarch64" });
	expect((result.code as string).includes(".Lneon_")).toBe(false);
}

const INIT_LOOP = `
import System

func fill = (ref Buffer<float> u, ref Buffer<float> v, int n) {
	if n <= u.cap && n <= v.cap {
		var i = 0
		while i < n; i += 1 {
			u.store_float(i, 1.0)
			v.store_float(i, 1.0)
		}
	}
}
pub func main = () {
	var u = Buffer<float>()
	var v = Buffer<float>()
	u.alloc_float(5)
	v.alloc_float(5)
	if u.cap >= 5 && v.cap >= 5 {
		fill(ref u, ref v, 5)
		Console.write("\\{u.load_float(0)} \\{u.load_float(4)} \\{v.load_float(2)}")
	}
}
`;

test("elementwise float loop emits a 2-lane NEON vector loop plus scalar tail", () => {
	const code = compile_aarch64(INIT_LOOP);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("asr x9, x9, #1");
	expect(code).toContain("mov x10, #0");
	expect(code).toContain("cmp x10, x9");
	expect(code).toContain("b.hs .Lneon_0_end");
	// Two distinct Buffers → two pinned data pointers (stores to both).
	expect(code).toContain("str q0, [x11, x10, lsl #4]");
	expect(code).toContain("str q0, [x12, x10, lsl #4]");
	// Induction sync hands the scalar tail the vector loop's exit counter.
	expect(code).toContain("lsl x0, x10, #1");
	// The scalar loop is still emitted (the tail).
	expect(code).toContain(".while_");
	expect(code).toContain(".end_while_");
});

test("same-buffer load+store elementwise loop vectorizes with one pinned pointer", () => {
	const code = compile_aarch64(`
import System

func double_all = (ref Buffer<float> b, int n) {
	if n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			b.store_float(i, b.load_float(i) * 2.0)
		}
	}
}
pub func main = () {}
`);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("ldr q0, [x11, x10, lsl #4]");
	expect(code).toContain("str q0, [x11, x10, lsl #4]");
	expect(code).toContain("fmul v0.2d, v0.2d, v1.2d");
	// The float literal splats across both lanes.
	expect(code).toContain("dup v0.2d, v0.d[0]");
});

test("per-lane temps ride v-registers through the vector body", () => {
	const code = compile_aarch64(`
import System

func scale = (ref Buffer<float> a, ref Buffer<float> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			const float x = a.load_float(i) * 2.0
			b.store_float(i, x + 1.0)
		}
	}
}
pub func main = () {}
`);
	expect(code).toContain(".Lneon_0:");
	// temp def → lane register, then read back by the store's value.
	expect(code).toContain("mov v4.16b, v0.16b");
	expect(code).toContain("mov v0.16b, v4.16b");
});

test("kill-switch restores scalar-only emission", () => {
	set_neon_vectorization_enabled(false);
	try {
		const code = compile_aarch64(INIT_LOOP);
		expect(code).not.toContain(".Lneon_");
		expect(code).not.toContain("asr x9, x9, #1");
	} finally {
		set_neon_vectorization_enabled(true);
	}
});

test("float reduction is NOT vectorized (reassociation forbidden)", () => {
	compiles_without_vector(`
import System

func dot = (ref Buffer<float> a, ref Buffer<float> b, int n, out float) {
	if n <= a.cap && n <= b.cap {
		var float acc = 0.0
		var i = 0
		while i < n; i += 1 {
			acc = acc + a.load_float(i) * b.load_float(i)
		}
		return acc
	}
	return 0.0
}
pub func main = () {}
`);
});

test("shifted element index is NOT vectorized (lane aliasing rule)", () => {
	compiles_lenient_without_vector(`
import System

func shift = (ref Buffer<float> a, ref Buffer<float> b, int n) {
	if n < a.cap && n < b.cap {
		var i = 0
		while i < n; i += 1 {
			b.store_float(i, a.load_float(i + 1))
		}
	}
}
pub func main = () {}
`);
});

test("non-zero induction init is NOT vectorized", () => {
	compiles_without_vector(`
import System

func run = (ref Buffer<float> b, int n) {
	if n <= b.cap {
		var i = 1
		while i < n; i += 1 {
			b.store_float(i, 1.0)
			i += 1
		}
	}
}
pub func main = () {}
`);
});

test("bound assigned inside the loop is NOT vectorized", () => {
	compiles_without_vector(`
import System

func run = (ref Buffer<float> b, int n) {
	if n <= b.cap {
		var m = n
		var i = 0
		while i < m; i += 1 {
			b.store_float(i, 1.0)
			i += 1
			m = m + 1
		}
	}
}
pub func main = () {}
`);
});

test("loop-carried temp (read in its own defining statement) is NOT vectorized", () => {
	compiles_without_vector(`
import System

func run = (ref Buffer<float> a, ref Buffer<float> b, int n) {
	if n <= a.cap && n <= b.cap {
		var float x = 0.0
		var i = 0
		while i < n; i += 1 {
			x = x + a.load_float(i)
			b.store_float(i, x)
		}
	}
}
pub func main = () {}
`);
});

test("control flow inside the loop body is NOT vectorized", () => {
	compiles_without_vector(`
import System

func run = (ref Buffer<float> b, int n) {
	if n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			if i > 2 {
				b.store_float(i, 1.0)
			}
			i += 1
		}
	}
}
pub func main = () {}
`);
});

test("arithmetic element index (row * w + col) is NOT vectorized", () => {
	compiles_lenient_without_vector(`
import System

func run = (ref Buffer<float> m, int w, int h) {
	if w * h <= m.cap {
		var row = 0
		while row < h; row += 1 {
			var col = 0
			while col < w; col += 1 {
				m.store_float(row * w + col, 0.5)
				col += 1
			}
			row += 1
		}
	}
}
pub func main = () {}
`);
});

test("behavioral: elementwise vector loop prints exact results", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func scale_into = (ref Buffer<float> a, ref Buffer<float> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			const float x = a.load_float(i) * 2.0
			b.store_float(i, x + 1.0)
		}
	}
}
pub func main = (Init init) {
	var a = Buffer<float>()
	var b = Buffer<float>()
	a.alloc_float(7)
	b.alloc_float(7)
	var i = 0
	while i < 7 {
		a.store_float(i, i as float * 0.5)
		i += 1
	}
	scale_into(ref a, ref b, 7)
	i = 0
	while i < 7 {
		Console.write("\\{b.load_float(i)} ")
		i += 1
	}
}
`,
		"neon_vector_elementwise",
		"1.000000 2.000000 3.000000 4.000000 5.000000 6.000000 7.000000 ",
		true,
	);
});

test("behavioral: fill loop vectorized on both buffers prints exact values", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(INIT_LOOP, "neon_vector_fill", "1.000000 1.000000 1.000000", true);
});
