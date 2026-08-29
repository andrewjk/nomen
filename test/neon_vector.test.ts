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

// --- Tranche 2: unroll-by-2, for-range, int/uint32 element kinds, threshold --

test("vector loop is unrolled to two groups per iteration", () => {
	const code = compile_aarch64(INIT_LOOP);
	// Two lane copies: the second rides x14 = x10 + 1; the counter steps 2
	// group units per iteration.
	expect(code).toContain("add x14, x10, #1");
	expect(code).toContain("str q0, [x14, lsl #4]".replace("[x14, lsl", "[x11, x14, lsl"));
	expect(code).toContain("str q0, [x12, x14, lsl #4]");
	expect(code).toContain("add x10, x10, #2");
	// limit = floor(n/2) rounded down to whole double-groups
	expect(code).toContain("asr x9, x9, #1");
	expect(code).toContain("bic x9, x9, #1");
});

test("for i of 0 .. n range loops vectorize", () => {
	const code = compile_aarch64(`
import System

func fill = (ref Buffer<float> u, int n) {
	if n <= u.cap {
		for i of 0 .. n {
			u.store_float(i, 2.5)
		}
	}
}
pub func main = () {}
`);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("dup v0.2d, v0.d[0]");
	// The scalar range loop is still emitted (the tail).
	expect(code).toContain(".for_");
});

test("non-zero range start is NOT vectorized", () => {
	compiles_without_vector(`
import System

func off = (ref Buffer<float> u, int n) {
	if n <= u.cap {
		for i of 2 .. n {
			u.store_float(i, 1.0)
		}
	}
}
pub func main = () {}
`);
});

test("8-byte int buffers vectorize with wrap-exact integer add", () => {
	const code = compile_aarch64(`
import System

func scale = (ref Buffer<int> a, ref Buffer<int> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			const int x = a.load_int(i) + 3
			b.store_int(i, x + 1)
		}
	}
}
pub func main = () {}
`);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("add v0.2d, v0.2d, v1.2d");
	// int literals splat from the gpr path
	expect(code).toContain("dup v0.2d, x0");
});

test("4-byte uint32 buffers vectorize as .4s groups", () => {
	const code = compile_aarch64(`
import System

func bump = (ref Buffer<uint32> a, ref Buffer<uint32> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			b.store(i, a.load(i) + 5)
		}
	}
}
pub func main = () {}
`);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("add v0.4s, v0.4s, v1.4s");
	expect(code).toContain("dup v0.4s, w0");
	// 4 elements per group: limit shift #2, sync shift #2
	expect(code).toContain("asr x9, x9, #2");
	expect(code).toContain("lsl x0, x10, #2");
});

test("integer bitwise ops vectorize as .16b", () => {
	const code = compile_aarch64(`
import System

func mask = (ref Buffer<int> a, ref Buffer<int> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			b.store_int(i, a.load_int(i) & 255)
		}
	}
}
pub func main = () {}
`);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("and v0.16b, v0.16b, v1.16b");
});

test("integer division is NOT vectorized (no NEON int div)", () => {
	compiles_without_vector(`
import System

func half = (ref Buffer<int> a, ref Buffer<int> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			b.store_int(i, a.load_int(i) / 2)
		}
	}
}
pub func main = () {}
`);
});

test("mixed element kinds in one loop are NOT vectorized", () => {
	compiles_without_vector(`
import System

func bad = (ref Buffer<float> a, ref Buffer<int> c, int n) {
	if n <= a.cap && n <= c.cap {
		var i = 0
		while i < n; i += 1 {
			a.store_float(i, 1.0)
			c.store_int(i, 2)
		}
	}
}
pub func main = () {}
`);
});

test("tiny literal bounds stay scalar (cost threshold)", () => {
	compiles_without_vector(`
import System

pub func main = () {
	var a = Buffer<float>()
	a.alloc_float(4)
	if 4 <= a.cap {
		var i = 0
		while i < 4; i += 1 {
			a.store_float(i, 1.0)
		}
	}
}
`);
});

test("behavioral: unrolled vector loop handles every remainder size", async () => {
	// a[i] = i * 0.5; b[i] = a[i] * 2 + 1 = i + 1. n=9 exercises one full
	// double-group (elements 0..3), a partial second (4..7) and a tail
	// element (8).
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
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
pub func main = (Init init) {
	var a = Buffer<float>()
	var b = Buffer<float>()
	a.alloc_float(9)
	b.alloc_float(9)
	if 9 <= a.cap && 9 <= b.cap {
		var i = 0
		while i < 9 {
			a.store_float(i, i as float * 0.5)
			i += 1
		}
		scale_into(ref a, ref b, 9)
		i = 0
		while i < 9 {
			Console.write("\\{b.load_float(i)} ")
			i += 1
		}
	}
}
`,
		"neon_vector_unroll_edges",
		"1.000000 2.000000 3.000000 4.000000 5.000000 6.000000 7.000000 8.000000 9.000000 ",
		true,
	);
});

test("behavioral: int buffer vector loop prints exact values", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System
func scale_into = (ref Buffer<int> a, ref Buffer<int> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			const int x = a.load_int(i) + 3
			b.store_int(i, x + 1)
		}
	}
}
pub func main = (Init init) {
	var a = Buffer<int>()
	var b = Buffer<int>()
	a.alloc_int(9)
	b.alloc_int(9)
	if 9 <= a.cap && 9 <= b.cap {
		var i = 0
		while i < 9 {
			a.store_int(i, i * 2)
			i += 1
		}
		scale_into(ref a, ref b, 9)
		i = 0
		while i < 9 {
			Console.write("\\{b.load_int(i)} ")
			i += 1
		}
	}
}
`,
		"neon_vector_int",
		"4 6 8 10 12 14 16 18 20 ",
		true,
	);
});

test("behavioral: for-range vector loop prints exact values", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func fill = (ref Buffer<float> u, int n) {
	if n <= u.cap {
		for i of 0 .. n {
			u.store_float(i, i as float * 0.5 + 1.0)
		}
	}
}
pub func main = (Init init) {
	var u = Buffer<float>()
	u.alloc_float(9)
	if 9 <= u.cap {
		fill(ref u, 9)
		var i = 0
		while i < 9 {
			Console.write("\\{u.load_float(i)} ")
			i += 1
		}
	}
}
`,
		"neon_vector_range",
		"1.000000 1.500000 2.000000 2.500000 3.000000 3.500000 4.000000 4.500000 5.000000 ",
		true,
	);
});

// --- Tranche 3: float reductions behind the fast_math opt-in -----------------

const DOT = `
import System

func dot = (ref Buffer<float> a, ref Buffer<float> b, int n, out float) {
	if n <= a.cap && n <= b.cap {
		var float acc = 0.0
		var i = 0
		while i < n; i += 1 {
			acc += a.load_float(i) * b.load_float(i)
		}
		return acc
	}
	return 0.0
}
pub func main = () {}
`;

function compile_aarch64_fast(source: string, fast_math: boolean): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", fast_math });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

test("float reductions stay scalar without the fast_math opt-in", () => {
	const code = compile_aarch64_fast(DOT, false);
	expect(code).not.toContain(".Lneon_");
	expect(code).not.toContain("faddp");
});

test("fast_math vectorizes dot-product reductions (v2 accumulator + faddp)", () => {
	const code = compile_aarch64_fast(DOT, true);
	expect(code).toContain(".Lneon_0:");
	// accumulator init splat, vector accumulate, horizontal combine
	expect(code).toContain("dup v2.2d, v0.d[0]");
	expect(code).toContain("fadd v2.2d, v2.2d, v0.2d");
	expect(code).toContain("faddp d0, v2.2d");
	// the scalar loop is still the tail
	expect(code).toContain(".while_");
});

test("fast_math vectorizes two independent accumulators (v2 + v3)", () => {
	const code = compile_aarch64_fast(
		`
import System

func sums = (ref Buffer<float> a, ref Buffer<float> b, int n, out float) {
	if n <= a.cap && n <= b.cap {
		var float s1 = 0.0
		var float s2 = 0.0
		var i = 0
		while i < n; i += 1 {
			s1 = s1 + a.load_float(i)
			s2 = s2 + b.load_float(i)
		}
		return s1 + s2
	}
	return 0.0
}
pub func main = () {}
`,
		true,
	);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("dup v2.2d, v0.d[0]");
	expect(code).toContain("dup v3.2d, v0.d[0]");
	expect(code).toContain("fadd v2.2d, v2.2d, v0.2d");
	expect(code).toContain("fadd v3.2d, v3.2d, v0.2d");
	expect(code).toContain("faddp d0, v2.2d");
	expect(code).toContain("faddp d0, v3.2d");
});

test("fast_math vectorizes multiplicative reductions", () => {
	const code = compile_aarch64_fast(
		`
import System

func prod = (ref Buffer<float> a, int n, out float) {
	if n <= a.cap {
		var float p = 1.0
		var i = 0
		while i < n; i += 1 {
			p = p * a.load_float(i)
		}
		return p
	}
	return 0.0
}
pub func main = () {}
`,
		true,
	);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("fmul v2.2d, v2.2d, v0.2d");
	expect(code).toContain("fmul d0, v2.d[0], v2.d[1]");
});

test("accumulator read outside its own reduction rejects", () => {
	const code = compile_aarch64_fast(
		`
import System

func bad = (ref Buffer<float> a, ref Buffer<float> b, int n) {
	if n <= a.cap && n <= b.cap {
		var float acc = 0.0
		var i = 0
		while i < n; i += 1 {
			acc = acc + a.load_float(i)
			b.store_float(i, acc)
		}
	}
}
pub func main = () {}
`,
		true,
	);
	expect(code).not.toContain(".Lneon_");
});

test("double reduction assignment rejects", () => {
	const code = compile_aarch64_fast(
		`
import System

func bad = (ref Buffer<float> a, int n) {
	if n <= a.cap {
		var float acc = 0.0
		var i = 0
		while i < n; i += 1 {
			acc = acc + a.load_float(i)
			acc = acc + 1.0
		}
	}
}
pub func main = () {}
`,
		true,
	);
	expect(code).not.toContain(".Lneon_");
});

test("non-associative accumulator ops (- and /) reject", () => {
	for (const op of ["-", "/"]) {
		const code = compile_aarch64_fast(
			`
import System

func bad = (ref Buffer<float> a, int n) {
	if n <= a.cap {
		var float acc = 0.0
		var i = 0
		while i < n; i += 1 {
			acc = acc ${op} a.load_float(i)
		}
	}
}
pub func main = () {}
`,
			true,
		);
		expect(code).not.toContain(".Lneon_");
	}
});

test("behavioral: vectorized reductions print exact dyadic results", async () => {
	// Dyadic values (halves/quarters) sum exactly in f64, so reassociation
	// cannot change the printed output; n=9 (vector+tail) and n=1 (tail
	// only, vector accumulator still horizontally combined) both covered.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func dot = (ref Buffer<float> a, ref Buffer<float> b, int n, out float) {
	if n <= a.cap && n <= b.cap {
		var float acc = 0.0
		var i = 0
		while i < n; i += 1 {
			acc += a.load_float(i) * b.load_float(i)
		}
		return acc
	}
	return 0.0
}

func sums = (ref Buffer<float> a, ref Buffer<float> b, int n, out float) {
	if n <= a.cap && n <= b.cap {
		var float s1 = 0.0
		var float s2 = 0.0
		var i = 0
		while i < n; i += 1 {
			s1 = s1 + a.load_float(i)
			s2 = s2 + b.load_float(i)
		}
		return s1 + s2
	}
	return 0.0
}

pub func main = () {
	var a = Buffer<float>()
	var b = Buffer<float>()
	a.alloc_float(9)
	b.alloc_float(9)
	if 9 <= a.cap && 9 <= b.cap {
		var i = 0
		while i < 9 {
			a.store_float(i, 0.5)
			b.store_float(i, 0.25)
			i += 1
		}
		Console.write("\\{dot(ref a, ref b, 9)} \\{sums(ref a, ref b, 9)} ")
		Console.write("\\{dot(ref a, ref b, 1)} \\{sums(ref a, ref b, 1)}")
	}
}
`,
		"neon_vector_reduction",
		"1.125000 6.750000 0.125000 0.750000",
		true,
		{ fast_math: true },
	);
});

// --- Tranche 4: integer reductions (bit-exact, no opt-in) --------------------

test("int64 sum reductions vectorize WITHOUT fast_math (wrap-exact)", () => {
	const code = compile_aarch64_fast(
		`
import System

func total = (ref Buffer<int> a, int n, out int) {
	if n <= a.cap {
		var int acc = 0
		var i = 0
		while i < n; i += 1 {
			acc += a.load_int(i)
		}
		return acc
	}
	return 0
}
pub func main = () {}
`,
		false,
	);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("add v2.2d, v2.2d, v0.2d");
	// .2d horizontal combine: scalar ADDP, bits routed through x0
	expect(code).toContain("addp d0, v2.2d");
	expect(code).toContain("fmov x0, d0");
});

test("uint32 sum reductions vectorize with an ADDV combine", () => {
	const code = compile_aarch64_fast(
		`
import System

func total = (ref Buffer<uint32> a, int n, out int) {
	if n <= a.cap {
		var uint32 acc = 0
		var i = 0
		while i < n; i += 1 {
			acc = acc + a.load(i)
		}
		return acc as int
	}
	return 0
}
pub func main = () {}
`,
		false,
	);
	expect(code).toContain(".Lneon_0:");
	expect(code).toContain("add v2.4s, v2.4s, v0.4s");
	// .4s horizontal combine: add-across, 32-bit move to x0
	expect(code).toContain("addv s0, v2.4s");
	expect(code).toContain("fmov w0, s0");
});

test("integer multiply reductions still reject (no horizontal combine)", () => {
	const code = compile_aarch64_fast(
		`
import System

func bad = (ref Buffer<int> a, int n) {
	if n <= a.cap {
		var int p = 1
		var i = 0
		while i < n; i += 1 {
			p = p * a.load_int(i)
		}
	}
}
pub func main = () {}
`,
		true,
	);
	expect(code).not.toContain(".Lneon_");
});

test("behavioral: int reductions are exact (negatives, range-for, tail, wrap)", async () => {
	// total(9) sums (i-4)*1e6 → 0 (negatives included); range_sum rides the
	// range-for reduction; total(1) is tail-only; the uint32 sum wraps mod
	// 2^32: 9 × (2^32 - 1000) ≡ 2^32 - 9009 = 4294958287.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func total = (ref Buffer<int> a, int n, out int) {
	if n <= a.cap {
		var int acc = 0
		var i = 0
		while i < n; i += 1 {
			acc += a.load_int(i)
		}
		return acc
	}
	return 0
}

func range_sum = (ref Buffer<int> a, int n, out int) {
	if n <= a.cap {
		var int s = 0
		for i of 0 .. n {
			s += a.load_int(i)
		}
		return s
	}
	return 0
}

pub func main = () {
	var a = Buffer<int>()
	a.alloc_int(9)
	if 9 <= a.cap {
		var i = 0
		while i < 9 {
			a.store_int(i, (i - 4) * 1000000)
			i += 1
		}
		Console.write("\\{total(ref a, 9)} \\{range_sum(ref a, 9)} \\{total(ref a, 1)}")
	}
	var b = Buffer<uint32>()
	b.alloc(9)
	if 9 <= b.cap {
		var i = 0
		while i < 9 {
			b.store(i, 4294967295 - 1000)
			i += 1
		}
		var uint32 acc = 0
		var i2 = 0
		while i2 < 9; i2 += 1 {
			acc += b.load(i2)
		}
		Console.write(" \\{acc as int}")
	}
}
`,
		"neon_vector_int_reduction",
		"0 0 -4000000 4294958287",
		true,
	);
});
