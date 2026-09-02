import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";

/**
 * Accumulator-aware loop promotion (ASM_PLAN_2 tranche D): a variable
 * WRITTEN in a loop body is a loop-carried accumulator — its slot
 * round-trip executes every iteration even when the TEXT has a single
 * read. Those qualify for promotion with reads >= 1 (aliased/ref/heap
 * storage stays excluded).
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const SPECTRAL_SHAPE = `
import System

func eval_a_times_u = (ref Buffer<float> au, ref Buffer<float> u, int n) {
	if n <= au.cap && n <= u.cap {
		var i = 0
		while i < n; i += 1 {
			var a = 0.0
			var j = 0
			while j < n; j += 1 {
				a = a + u.load_float(j) * 2.0
			}
			au.store_float(i, a)
		}
	}
}
pub func main = () {}
`;

test("loop accumulator declared in the body gets promoted (spectral shape)", () => {
	const code = compile(SPECTRAL_SHAPE);
	const fn = code.slice(code.indexOf("\neval_a_times_u:"), code.indexOf("\n_main:"));
	// `a` must live in a promoted d-register: the add writes a d-reg
	// directly (tree-allocated temps for the operands) — the accumulator
	// slot round-trip is gone.
	expect(fn).toMatch(/fadd d\d+, d\d+, d\d+/);
});

test("behavioral: accumulator loop prints exact results", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func scale_rows = (ref Buffer<float> au, ref Buffer<float> u, int n) {
	if n <= au.cap && n <= u.cap {
		var i = 0
		while i < n; i += 1 {
			var a = 0.0
			var j = 0
			while j < n; j += 1 {
				a = a + u.load_float(j) * 2.0
			}
			au.store_float(i, a)
		}
	}
}
pub func main = () {
	var u = Buffer<float>()
	var au = Buffer<float>()
	u.alloc_float(4)
	au.alloc_float(4)
	if u.cap >= 4 && au.cap >= 4 {
		var k = 0
		while k < 4; k += 1 {
			u.store_float(k, k as float + 1.0)
		}
		scale_rows(ref au, ref u, 4)
		var j = 0
		while j < 4; j += 1 {
			Console.write("\\{au.load_float(j)} ")
		}
	}
}
`,
		"accumulator_promotion",
		"20.000000 20.000000 20.000000 20.000000 ",
		true,
	);
});

/**
 * Declare-slot pre-allocation (ASM_PLAN_2 tranche D addendum): a local
 * declared INSIDE a loop body has no stack slot when promote_loop_locals
 * runs, so it never promoted. The pass now pre-allocates the slot (the
 * declare build reuses that exact offset), closing nbody's advance shape:
 * `const float dx = …` declared and read in the same while loop.
 */

const ADVANCE_SHAPE = `
import System

func advance = (ref Buffer<float> xs, ref Buffer<float> vs, int n) {
	if n <= xs.cap && n <= vs.cap {
		var i = 0
		while i < n; i += 1 {
			var float vx = vs.load_float(i)
			var int j = i + 1
			while j < n; j += 1 {
				const float dx = xs.load_float(j)
				vx = vx - dx
				vx = vx - dx
				vx = vx - dx
			}
			vs.store_float(i, vx)
		}
	}
}
pub func main = () {}
`;

test("body-declared locals promote in their own loop via pre-allocated slots", () => {
	const code = compile(ADVANCE_SHAPE);
	const fn = code.slice(code.indexOf("\nadvance:"), code.indexOf("\nmain:"));
	// The slot round-trip signature this tranche deletes: a declare storing
	// the float's bits through x0 (`str x0, [x29, #N]`) with any later read
	// loading it back into the FP domain (`ldr dN, [x29, #N]`). dx (3 reads,
	// declared in the inner body — below the whole-function pass's 4-read
	// bar, so the LOOP pass claims it via pre-allocation) and vx (outer-body
	// accumulator) must both live in registers end to end.
	const slot_writes = [...fn.matchAll(/str x0, \[x29, #(\d+)\]/g)].map((m) => m[1]);
	for (const offset of slot_writes) {
		expect(fn).not.toMatch(new RegExp(`ldr d\\d+, \\[x29, #${offset}\\]`));
	}
	// The promoted declares initialize their d-register directly — the
	// float declare fast path (ASM_PLAN_3) either lands the initializer's
	// root op straight in the target register (dest hint) or moves it from
	// d0 (call/load_float RHS rides the d0 protocol); the historical
	// d0 → x0 → dN writeback crossing is gone.
	expect(fn).toMatch(/fmov d\d+, d0/);
	expect(fn).not.toMatch(/fmov d\d+, x0/);
});

test("behavioral: body-declared loop locals keep exact per-iteration semantics", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func sum_terms = () {
	var i = 0
	while i < 4; i += 1 {
		var float acc = 0.0
		var int j = 0
		while j < 4; j += 1 {
			const float term = j as float + 1.0
			acc = acc + term
			acc = acc + term
			acc = acc + term
		}
		acc = acc + i as float
		Console.write("\\{acc} ")
	}
}
pub func main = () {
	sum_terms()
}
`,
		"declare_slot_promotion",
		"30.000000 31.000000 32.000000 33.000000 ",
		true,
	);
});
